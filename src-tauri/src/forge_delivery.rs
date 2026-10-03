//! Provider detail operations. Authentication remains owned by gh/glab/az.
use super::*;
use crate::delivery::{CiNode, ReviewThread, ThreadComment};
use serde_json::{json, Value};

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}
fn ident(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .map(str::to_string)
        .or_else(|| v[key].as_u64().map(|n| n.to_string()))
        .unwrap_or_default()
}
fn checked_output(
    provider: &str,
    cwd: &Path,
    args: &[String],
) -> Result<CmdOut, String> {
    let cli = cli_for_provider(provider);
    let bin = reprobe_bin(cli).ok_or_else(|| format!("{cli} is not installed"))?;
    let mut argv = args.to_vec();
    // gh api otherwise defaults to github.com even in an Enterprise checkout.
    if provider == GITHUB && argv.first().map(String::as_str) == Some("api") {
        let remote = crate::git(
            &["remote", "get-url", &crate::detect_default_remote(cwd)],
            cwd,
        )
        .map_err(|e| e.to_string())?;
        let host = host_of_remote(&remote).ok_or("cannot resolve GitHub host")?;
        argv.extend(["--hostname".into(), host]);
    }
    let refs: Vec<_> = argv.iter().map(String::as_str).collect();
    let out = run(&bin, &refs, Some(cwd)).map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("{}", classify_failure(provider, &out)));
    }
    Ok(out)
}
fn cli_json(provider: &str, cwd: &Path, args: Vec<String>) -> Result<Value, String> {
    let out = checked_output(provider, cwd, &args)?;
    serde_json::from_slice(&out.stdout).map_err(|e| format!("invalid provider JSON: {e}"))
}
fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn rest(provider: &str, cwd: &Path, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let mut argv = args(&["api", path]);
    let temporary = body
        .map(|_| std::env::temp_dir().join(format!("termic-reply-{}.json", uuid::Uuid::new_v4())));
    if let (Some(body), Some(file)) = (body, &temporary) {
        private_body(file, body)?;
        argv.extend([
            "--method".into(),
            "POST".into(),
            "--input".into(),
            file.to_string_lossy().into_owned(),
        ]);
    }
    let result = cli_json(provider, cwd, argv);
    if let Some(file) = temporary {
        let _ = std::fs::remove_file(file);
    }
    result
}
fn private_body(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(value.to_string().as_bytes())
        .map_err(|e| e.to_string())
}
fn pages(provider: &str, cwd: &Path, path: &str) -> Result<Vec<Value>, String> {
    let mut all = vec![];
    // Explicit ceiling prevents a large MR monopolizing the app's worker pool.
    for page in 1..=20 {
        let sep = if path.contains('?') { '&' } else { '?' };
        let v = rest(
            provider,
            cwd,
            &format!("{path}{sep}per_page=100&page={page}"),
            None,
        )?;
        let batch = v.as_array().ok_or("expected a provider list")?;
        all.extend(batch.iter().cloned());
        if batch.len() < 100 {
            return Ok(all);
        }
    }
    Err("More than 2,000 items. Open the full list on the provider.".into())
}
fn azure(
    cwd: &Path,
    area: &str,
    resource: &str,
    route: &[(&str, String)],
    body: Option<&Value>,
) -> Result<Value, String> {
    let (org, project, _) = azure_scope(cwd).map_err(|e| e.to_string())?;
    let mut argv = args(&[
        "devops",
        "invoke",
        "--area",
        area,
        "--resource",
        resource,
        "--org",
        &org,
        "--api-version",
        "7.1",
        "--output",
        "json",
        "--route-parameters",
    ]);
    argv.push(format!("project={project}"));
    argv.extend(route.iter().map(|(k, v)| format!("{k}={v}")));
    let file = body
        .map(|_| std::env::temp_dir().join(format!("termic-reply-{}.json", uuid::Uuid::new_v4())));
    if let (Some(body), Some(file)) = (body, &file) {
        private_body(file, body)?;
        argv.extend([
            "--http-method".into(),
            "POST".into(),
            "--in-file".into(),
            file.to_string_lossy().into_owned(),
        ]);
    }
    let result = cli_json(AZURE, cwd, argv);
    if let Some(file) = file {
        let _ = std::fs::remove_file(file);
    }
    result
}

pub fn revision(provider: &str, cwd: &Path, number: u64) -> Result<String, String> {
    let n = number.to_string();
    let v = match provider {
        GITHUB => rest(
            provider,
            cwd,
            &format!("repos/{{owner}}/{{repo}}/pulls/{n}"),
            None,
        )?,
        GITLAB => rest(
            provider,
            cwd,
            &format!("projects/:id/merge_requests/{n}"),
            None,
        )?,
        AZURE => {
            let (org, project, _) = azure_scope(cwd).map_err(|e| e.to_string())?;
            cli_json(
                provider,
                cwd,
                args(&[
                    "repos",
                    "pr",
                    "show",
                    "--id",
                    &n,
                    "--org",
                    &org,
                    "--project",
                    &project,
                    "-o",
                    "json",
                ]),
            )?
        }
        _ => return Err("unsupported provider".into()),
    };
    let sha = match provider {
        GITHUB => text(&v["head"], "sha"),
        GITLAB => text(&v, "sha"),
        _ => text(&v["lastMergeSourceCommit"], "commitId"),
    };
    if !crate::is_commit_ish(&sha) {
        return Err("provider did not identify the PR revision".into());
    }
    Ok(sha)
}
fn state(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "success" | "succeeded" | "passed" | "approved" => "passed",
        // Azure build *results* that mean "finished, something needs a look"
        // (partiallysucceeded / abandoned) land here lowercased too.
        "failure"
        | "failed"
        | "timed_out"
        | "startup_failure"
        | "rejected"
        | "broken"
        | "partiallysucceeded"
        | "succeededwithissues"
        | "abandoned" => "failed",
        "cancelled" | "canceled" => "canceled",
        "skipped" | "neutral" | "notapplicable" => "skipped",
        "action_required" | "manual" | "waiting" => "approval",
        // Azure *statuses* land here lowercased: inProgress/cancelling/postponed.
        "in_progress" | "inprogress" | "running" | "cancelling" | "postponed" => "running",
        "queued"
        | "pending"
        | "created"
        | "notstarted"
        | "notset"
        | "preparing"
        | "scheduled"
        | "waiting_for_resource" => "pending",
        _ => "unknown",
    }
    .to_string()
}
fn duration(v: &Value, start: &str, end: &str) -> Option<f64> {
    let a = chrono::DateTime::parse_from_rfc3339(v[start].as_str()?).ok()?;
    let b = chrono::DateTime::parse_from_rfc3339(v[end].as_str()?).ok()?;
    Some((b - a).num_milliseconds().max(0) as f64 / 1000.)
}
fn node(
    id: String,
    parent: Option<String>,
    name: String,
    kind: &str,
    status: &str,
    url: String,
    log_id: Option<String>,
) -> CiNode {
    CiNode {
        id,
        parent,
        name,
        kind: kind.into(),
        status: state(status),
        url,
        log_id,
        duration: None,
    }
}

pub fn ci(provider: &str, cwd: &Path, number: u64, expected: &str) -> Result<Vec<CiNode>, String> {
    match provider {
        GITHUB => github_ci(cwd, number, expected),
        GITLAB => gitlab_ci(cwd, number, expected),
        AZURE => azure_ci(cwd, number, expected),
        _ => Err("unsupported provider".into()),
    }
}
fn github_ci(cwd: &Path, number: u64, expected: &str) -> Result<Vec<CiNode>, String> {
    let pr = rest(
        GITHUB,
        cwd,
        &format!("repos/{{owner}}/{{repo}}/pulls/{number}"),
        None,
    )?;
    if text(&pr["head"], "sha") != expected {
        return Err("PR revision changed. Refresh before reviewing CI.".into());
    }
    let mut revisions = vec![expected.to_string()];
    if pr["mergeable"].as_bool() == Some(true) {
        if let Some(sha) = pr["merge_commit_sha"]
            .as_str()
            .filter(|s| crate::is_commit_ish(s))
        {
            if merge_revision_matches(GITHUB, cwd, sha, expected)? {
                revisions.push(sha.into());
            }
        }
    }
    let mut runs = HashSet::new();
    let mut nodes = vec![];
    for sha in &revisions {
        let checks = rest(
            GITHUB,
            cwd,
            &format!("repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100"),
            None,
        )?;
        let list = checks["check_runs"]
            .as_array()
            .ok_or("missing GitHub checks")?;
        if checks["total_count"].as_u64().unwrap_or(0) > list.len() as u64 {
            return Err("More than 100 checks. Open the full checks list on GitHub.".into());
        }
        for check in list {
            let url = text(check, "details_url");
            let parts: Vec<_> = url.split('/').collect();
            let run = parts
                .iter()
                .position(|p| *p == "runs")
                .and_then(|i| parts.get(i + 1))
                .and_then(|s| s.parse::<u64>().ok());
            if let Some(run) = run {
                runs.insert(run);
            } else {
                let status = check["conclusion"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| check["status"].as_str().unwrap_or(""));
                nodes.push(node(
                    format!("check:{}", ident(check, "id")),
                    None,
                    text(check, "name"),
                    "check",
                    status,
                    url,
                    None,
                ));
            }
        }
        let statuses = pages(
            GITHUB,
            cwd,
            &format!("repos/{{owner}}/{{repo}}/commits/{sha}/statuses"),
        )?;
        let mut seen = HashSet::new();
        for status in statuses {
            let name = text(&status, "context");
            if !seen.insert(name.clone()) {
                continue;
            }
            nodes.push(node(
                format!("status:{}", ident(&status, "id")),
                None,
                name,
                "check",
                &text(&status, "state"),
                text(&status, "target_url"),
                None,
            ));
        }
    }
    for run in runs {
        let v = cli_json(
            GITHUB,
            cwd,
            args(&[
                "run",
                "view",
                &run.to_string(),
                "--json",
                "jobs,workflowName,headSha,headBranch,url,status,conclusion",
            ]),
        )?;
        if !github_run_matches(&v, &text(&pr["head"], "ref"), &revisions) {
            continue;
        }
        let root = format!("gh:{run}");
        let verdict = v["conclusion"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| v["status"].as_str().unwrap_or(""));
        nodes.push(node(
            root.clone(),
            None,
            text(&v, "workflowName"),
            "workflow",
            verdict,
            text(&v, "url"),
            None,
        ));
        for job in v["jobs"].as_array().unwrap_or(&vec![]) {
            let jid = ident(job, "databaseId");
            let id = format!("gh:{run}:{jid}");
            let verdict = job["conclusion"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| job["status"].as_str().unwrap_or(""));
            let mut n = node(
                id.clone(),
                Some(root.clone()),
                text(job, "name"),
                "job",
                verdict,
                text(job, "url"),
                Some(format!("gh:{jid}")),
            );
            n.duration = duration(job, "startedAt", "completedAt");
            nodes.push(n);
            for step in job["steps"].as_array().unwrap_or(&vec![]) {
                let verdict = step["conclusion"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| step["status"].as_str().unwrap_or(""));
                let mut n = node(
                    format!("{id}:{}", ident(step, "number")),
                    Some(id.clone()),
                    text(step, "name"),
                    "step",
                    verdict,
                    text(job, "url"),
                    Some(format!("gh:{jid}")),
                );
                n.duration = duration(step, "startedAt", "completedAt");
                nodes.push(n);
            }
        }
    }
    Ok(nodes)
}
fn gitlab_ci(cwd: &Path, number: u64, expected: &str) -> Result<Vec<CiNode>, String> {
    let mr = rest(
        GITLAB,
        cwd,
        &format!("projects/:id/merge_requests/{number}"),
        None,
    )?;
    if text(&mr, "sha") != expected {
        return Err("MR revision changed. Refresh before reviewing CI.".into());
    }
    let mut pipelines = pages(
        GITLAB,
        cwd,
        &format!("projects/:id/merge_requests/{number}/pipelines"),
    )?;
    pipelines.sort_by_key(|p| std::cmp::Reverse(p["id"].as_u64().unwrap_or_default()));
    let merge_sha = text(&mr["head_pipeline"], "sha");
    let mut nodes = vec![];
    // Keep the newest run for each pipeline ref, not superseded attempts.
    let mut refs = HashSet::new();
    for p in pipelines {
        let sha = text(&p, "sha");
        let reference = text(&p, "ref");
        if sha != expected
            && !(sha == merge_sha
                && reference == format!("refs/merge-requests/{number}/merge")
                && merge_revision_matches(GITLAB, cwd, &sha, expected)?)
        {
            continue;
        }
        let pid = ident(&p, "id");
        // Pipelines with no ref would all collide on ""; fall back to the
        // pipeline id so distinct ref-less runs each survive the dedupe.
        if !refs.insert(if reference.is_empty() { pid.clone() } else { reference }) {
            continue;
        }
        let root = format!("gl:{pid}");
        nodes.push(node(
            root.clone(),
            None,
            format!("Pipeline {pid}"),
            "pipeline",
            &text(&p, "status"),
            text(&p, "web_url"),
            None,
        ));
        let jobs = pages(
            GITLAB,
            cwd,
            &format!("projects/:id/pipelines/{pid}/jobs?include_retried=false"),
        )?;
        let mut stages = HashSet::new();
        for j in jobs {
            let stage = text(&j, "stage");
            let parent = format!("{root}:stage:{stage}");
            if stages.insert(stage.clone()) {
                nodes.push(node(
                    parent.clone(),
                    Some(root.clone()),
                    stage,
                    "stage",
                    "",
                    String::new(),
                    None,
                ));
            }
            let jid = ident(&j, "id");
            let mut n = node(
                format!("gl:{pid}:{jid}"),
                Some(parent),
                text(&j, "name"),
                "job",
                &text(&j, "status"),
                text(&j, "web_url"),
                Some(format!("gl:{jid}")),
            );
            n.duration = j["duration"].as_f64();
            nodes.push(n);
        }
    }
    let stages: Vec<_> = nodes
        .iter()
        .filter(|n| n.kind == "stage")
        .map(|n| n.id.clone())
        .collect();
    for stage in stages {
        let states: Vec<_> = nodes
            .iter()
            .filter(|n| n.parent.as_deref() == Some(&stage))
            .map(|n| n.status.as_str())
            .collect();
        let verdict = aggregate(&states).to_string();
        if let Some(n) = nodes.iter_mut().find(|n| n.id == stage) {
            n.status = verdict;
        }
    }
    Ok(nodes)
}
fn azure_ci(cwd: &Path, number: u64, expected: &str) -> Result<Vec<CiNode>, String> {
    let (org, project, repo) = azure_scope(cwd).map_err(|e| e.to_string())?;
    let pr = cli_json(
        AZURE,
        cwd,
        args(&[
            "repos",
            "pr",
            "show",
            "--id",
            &number.to_string(),
            "--org",
            &org,
            "--project",
            &project,
            "-o",
            "json",
        ]),
    )?;
    if text(&pr["lastMergeSourceCommit"], "commitId") != expected
        || !azure_pr_in_repo(&pr, &project, &repo)
    {
        return Err("PR identity changed. Refresh before reviewing CI.".into());
    }
    let merge = text(&pr["lastMergeCommit"], "commitId");
    let repo_id = text(&pr["repository"], "id");
    let policies = cli_json(
        AZURE,
        cwd,
        args(&[
            "repos",
            "pr",
            "policy",
            "list",
            "--id",
            &number.to_string(),
            "--org",
            &org,
            "--project",
            &project,
            "-o",
            "json",
        ]),
    )?;
    let mut seen = HashSet::new();
    let mut nodes = vec![];
    for policy in policies
        .as_array()
        .ok_or("missing Azure policy evaluations")?
    {
        if policy["configuration"]["isEnabled"].as_bool() == Some(false) {
            continue;
        }
        if policy["context"]["buildIsNotCurrent"].as_bool() == Some(true)
            || policy["context"]["isExpired"].as_bool() == Some(true)
        {
            continue;
        }
        let Some(build) = policy["context"]["buildId"].as_u64() else {
            nodes.push(node(
                format!("policy:{}", ident(policy, "evaluationId")),
                None,
                text(&policy["configuration"]["type"], "displayName"),
                "policy",
                &text(policy, "status"),
                text(&pr, "url"),
                None,
            ));
            continue;
        };
        if !seen.insert(build) {
            continue;
        }
        let b = cli_json(
            AZURE,
            cwd,
            args(&[
                "pipelines",
                "runs",
                "show",
                "--id",
                &build.to_string(),
                "--org",
                &org,
                "--project",
                &project,
                "-o",
                "json",
            ]),
        )?;
        let sha = text(&b, "sourceVersion");
        if text(&b["repository"], "id") != repo_id
            || (sha != expected
                && (merge.is_empty()
                    || sha != merge
                    || !merge_revision_matches(AZURE, cwd, &sha, expected)?))
        {
            continue;
        }
        let root = format!("az:{build}");
        let url = text(&b["_links"]["web"], "href");
        let verdict = b["result"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| b["status"].as_str().unwrap_or(""));
        nodes.push(node(
            root.clone(),
            None,
            text(&b["definition"], "name"),
            "pipeline",
            verdict,
            url.clone(),
            None,
        ));
        let timeline = azure(
            cwd,
            "build",
            "timeline",
            &[("buildId", build.to_string())],
            None,
        )?;
        let records = timeline["records"]
            .as_array()
            .ok_or("missing Azure timeline")?;
        for r in records {
            let id = ident(r, "id");
            let parent = text(r, "parentId");
            let verdict = r["result"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| r["state"].as_str().unwrap_or(""));
            let log = r["log"]["id"].as_u64().map(|n| format!("az:{build}:{n}"));
            let kind = text(r, "type").to_lowercase();
            let mut n = node(
                format!("{root}:{id}"),
                Some(if parent.is_empty() {
                    root.clone()
                } else {
                    format!("{root}:{parent}")
                }),
                text(r, "name"),
                &kind,
                verdict,
                url.clone(),
                log,
            );
            n.duration = duration(r, "startTime", "finishTime");
            nodes.push(n);
        }
    }
    Ok(nodes)
}

pub fn threads(provider: &str, cwd: &Path, number: u64) -> Result<Vec<ReviewThread>, String> {
    match provider {
        GITHUB => github_threads(cwd, number),
        GITLAB => {
            let list = pages(
                GITLAB,
                cwd,
                &format!("projects/:id/merge_requests/{number}/discussions"),
            )?;
            Ok(list
                .iter()
                .filter_map(|d| {
                    let notes: Vec<_> = d["notes"]
                        .as_array()?
                        .iter()
                        .filter(|n| n["system"].as_bool() != Some(true))
                        .collect();
                    let first = *notes.first()?;
                    Some(ReviewThread {
                        id: ident(d, "id"),
                        reply_id: ident(first, "id"),
                        path: first["position"]["new_path"].as_str().map(str::to_string),
                        line: first["position"]["new_line"].as_u64(),
                        resolved: first["resolved"].as_bool(),
                        url: String::new(),
                        comments: notes
                            .iter()
                            .map(|n| ThreadComment {
                                id: ident(n, "id"),
                                author: text(&n["author"], "username"),
                                body: text(n, "body"),
                            })
                            .collect(),
                    })
                })
                .collect())
        }
        AZURE => {
            let (_, _, repo) = azure_scope(cwd).map_err(|e| e.to_string())?;
            let list = azure(
                cwd,
                "git",
                "pullRequestThreads",
                &[
                    ("repositoryId", repo),
                    ("pullRequestId", number.to_string()),
                ],
                None,
            )?;
            Ok(list["value"]
                .as_array()
                .ok_or("missing Azure review threads")?
                .iter()
                .filter(|d| d["isDeleted"].as_bool() != Some(true))
                .filter_map(|d| {
                    let comments: Vec<_> = d["comments"]
                        .as_array()?
                        .iter()
                        .filter(|n| {
                            n["isDeleted"].as_bool() != Some(true)
                                && n["commentType"].as_str() != Some("system")
                                && n["commentType"].as_u64() != Some(3)
                        })
                        .map(|n| ThreadComment {
                            id: ident(n, "id"),
                            author: text(&n["author"], "displayName"),
                            body: text(n, "content"),
                        })
                        .filter(|n| !n.body.is_empty())
                        .collect();
                    if comments.is_empty() {
                        return None;
                    }
                    let status = d["status"].as_str().map(str::to_lowercase).or_else(|| {
                        d["status"].as_u64().map(|n| {
                            match n {
                                1 => "active",
                                2 => "fixed",
                                3 => "wontfix",
                                4 => "closed",
                                5 => "bydesign",
                                6 => "pending",
                                _ => "unknown",
                            }
                            .into()
                        })
                    });
                    Some(ReviewThread {
                        id: ident(d, "id"),
                        reply_id: comments.first().map(|c| c.id.clone()).unwrap_or_default(),
                        path: d["threadContext"]["filePath"].as_str().map(str::to_string),
                        line: d["threadContext"]["rightFileStart"]["line"].as_u64(),
                        resolved: status
                            .as_deref()
                            .map(|s| matches!(s, "fixed" | "closed" | "wontfix" | "bydesign")),
                        url: String::new(),
                        comments,
                    })
                })
                .collect())
        }
        _ => Err("unsupported provider".into()),
    }
}
fn github_threads(cwd: &Path, number: u64) -> Result<Vec<ReviewThread>, String> {
    let repo = cli_json(GITHUB, cwd, args(&["repo", "view", "--json", "owner,name"]))?;
    let owner = text(&repo["owner"], "login");
    let name = text(&repo, "name");
    let mut cursor = Value::Null;
    let mut out = vec![];
    let query="query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved path line comments(first:100){totalCount nodes{databaseId body url author{login}}}}}}}}";
    for _ in 0..20 {
        let body = json!({"query":query,"variables":{"owner":owner,"name":name,"number":number,"cursor":cursor}});
        let v = rest(GITHUB, cwd, "graphql", Some(&body))?;
        if v["errors"].is_array() {
            return Err(format!(
                "GitHub review threads unavailable: {}",
                v["errors"]
            ));
        }
        let connection = &v["data"]["repository"]["pullRequest"]["reviewThreads"];
        for thread in connection["nodes"]
            .as_array()
            .ok_or("missing GitHub review threads")?
        {
            let comments = thread["comments"]["nodes"]
                .as_array()
                .ok_or("missing thread comments")?;
            if thread["comments"]["totalCount"].as_u64().unwrap_or(0) > comments.len() as u64 {
                return Err("Thread exceeds 100 replies. Open the full thread on GitHub.".into());
            }
            let Some(first) = comments.first() else {
                continue;
            };
            out.push(ReviewThread {
                id: text(thread, "id"),
                reply_id: ident(first, "databaseId"),
                path: thread["path"].as_str().map(str::to_string),
                line: thread["line"].as_u64(),
                resolved: thread["isResolved"].as_bool(),
                url: text(first, "url"),
                comments: comments
                    .iter()
                    .map(|c| ThreadComment {
                        id: ident(c, "databaseId"),
                        author: text(&c["author"], "login"),
                        body: text(c, "body"),
                    })
                    .collect(),
            });
        }
        if connection["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
            let discussion = pages(
                GITHUB,
                cwd,
                &format!("repos/{{owner}}/{{repo}}/issues/{number}/comments"),
            )?;
            if !discussion.is_empty() {
                out.push(ReviewThread {
                    id: "discussion".into(),
                    reply_id: String::new(),
                    path: None,
                    line: None,
                    resolved: None,
                    url: String::new(),
                    comments: discussion
                        .iter()
                        .map(|c| ThreadComment {
                            id: ident(c, "id"),
                            author: text(&c["user"], "login"),
                            body: text(c, "body"),
                        })
                        .collect(),
                });
            }
            return Ok(out);
        }
        cursor = connection["pageInfo"]["endCursor"].clone();
    }
    Err("More than 2,000 threads. Open the full review on GitHub.".into())
}

pub fn post_reply(
    provider: &str,
    cwd: &Path,
    number: u64,
    thread: &ReviewThread,
    body: &str,
) -> Result<(), String> {
    match provider {
        GITHUB => {
            let path = if thread.id == "discussion" {
                format!("repos/{{owner}}/{{repo}}/issues/{number}/comments")
            } else {
                format!(
                    "repos/{{owner}}/{{repo}}/pulls/{number}/comments/{}/replies",
                    thread.reply_id
                )
            };
            rest(provider, cwd, &path, Some(&json!({"body":body})))?;
        }
        GITLAB => {
            rest(
                provider,
                cwd,
                &format!(
                    "projects/:id/merge_requests/{number}/discussions/{}/notes",
                    thread.id
                ),
                Some(&json!({"body":body})),
            )?;
        }
        AZURE => {
            let (_, _, repo) = azure_scope(cwd).map_err(|e| e.to_string())?;
            azure(
                cwd,
                "git",
                "pullRequestThreadComments",
                &[
                    ("repositoryId", repo),
                    ("pullRequestId", number.to_string()),
                    ("threadId", thread.id.clone()),
                ],
                Some(
                    &json!({"content":body,"commentType":1,"parentCommentId":thread.reply_id.parse::<u64>().map_err(|_|"Invalid reply parent")?}),
                ),
            )?;
        }
        _ => return Err("unsupported provider".into()),
    }
    Ok(())
}

pub fn log(provider: &str, cwd: &Path, id: &str) -> Result<String, String> {
    let p: Vec<_> = id.split(':').collect();
    if p.iter().skip(1).any(|s| s.parse::<u64>().is_err()) {
        return Err("invalid log identity".into());
    }
    let out = match (provider, p.as_slice()) {
        (GITHUB, ["gh", job]) => checked_output(
            provider,
            cwd,
            &args(&["run", "view", "--job", job, "--log-failed"]),
        )?,
        (GITLAB, ["gl", job]) => checked_output(
            provider,
            cwd,
            &args(&["api", &format!("projects/:id/jobs/{job}/trace")]),
        )?,
        (AZURE, ["az", build, log]) => {
            let (org, project, _) = azure_scope(cwd).map_err(|e| e.to_string())?;
            checked_output(
                provider,
                cwd,
                &args(&[
                    "devops",
                    "invoke",
                    "--area",
                    "build",
                    "--resource",
                    "logs",
                    "--org",
                    &org,
                    "--api-version",
                    "7.1",
                    "--route-parameters",
                    &format!("project={project}"),
                    &format!("buildId={build}"),
                    &format!("logId={log}"),
                    "--query-parameters",
                    "startLine=0",
                    "endLine=300",
                    "-o",
                    "json",
                ]),
            )?
        }
        _ => return Err("invalid provider log".into()),
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let ansi = regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
        .map_err(|e| e.to_string())?;
    let raw = ansi.replace_all(&raw, "");
    let raw: String = raw
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
        .collect();
    let clipped: String = raw.chars().take(32000).collect();
    Ok(if provider == AZURE || raw.chars().count() > 32000 {
        format!("{clipped}\n[Excerpt truncated. Open the provider for the full log.]")
    } else {
        clipped
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ci_states_are_distinct() {
        assert_eq!(state("CANCELLED"), "canceled");
        assert_eq!(state("ACTION_REQUIRED"), "approval");
        assert_eq!(state("notStarted"), "pending");
        assert_eq!(state("FAILURE"), "failed");
        // Azure live statuses/results land lowercased — these used to fall
        // through to "unknown" and render a running build as dead.
        assert_eq!(state("inProgress"), "running");
        assert_eq!(state("postponed"), "running");
        assert_eq!(state("notSet"), "pending");
        assert_eq!(state("partiallySucceeded"), "failed");
        assert_eq!(state("abandoned"), "failed");
        assert_eq!(state("something-new"), "unknown");
        assert_eq!(aggregate(&["skipped"]), "skipped");
        assert_eq!(aggregate(&["passed", "canceled"]), "canceled");
        assert_eq!(aggregate(&["passed", "approval"]), "approval");
    }
}

fn aggregate<'a>(states: &[&'a str]) -> &'a str {
    for state in [
        "failed", "running", "approval", "pending", "canceled", "unknown",
    ] {
        if states.contains(&state) {
            return state;
        }
    }
    if !states.is_empty() && states.iter().all(|s| *s == "skipped") {
        return "skipped";
    }
    if !states.is_empty() && states.iter().all(|s| matches!(*s, "passed" | "skipped")) {
        return "passed";
    }
    "unknown"
}

fn parent_matches(commit: &Value, expected: &str) -> bool {
    commit["parents"]
        .as_array()
        .or_else(|| commit["parent_ids"].as_array())
        .is_some_and(|parents| {
            parents
                .iter()
                .any(|p| p.as_str() == Some(expected) || p["sha"].as_str() == Some(expected))
        })
}
fn github_run_matches(run: &Value, branch: &str, revisions: &[String]) -> bool {
    !branch.is_empty()
        && text(run, "headBranch") == branch
        && revisions.contains(&text(run, "headSha"))
}
fn merge_revision_matches(
    provider: &str,
    cwd: &Path,
    sha: &str,
    expected: &str,
) -> Result<bool, String> {
    if sha == expected {
        return Ok(true);
    }
    if !crate::is_commit_ish(sha) {
        return Ok(false);
    }
    let commit = match provider {
        GITHUB => rest(
            provider,
            cwd,
            &format!("repos/{{owner}}/{{repo}}/commits/{sha}"),
            None,
        )?,
        GITLAB => rest(
            provider,
            cwd,
            &format!("projects/:id/repository/commits/{sha}"),
            None,
        )?,
        AZURE => {
            let (_, _, repo) = azure_scope(cwd).map_err(|e| e.to_string())?;
            azure(
                cwd,
                "git",
                "commits",
                &[("repositoryId", repo), ("commitId", sha.into())],
                None,
            )?
        }
        _ => return Err("Unsupported merge revision provider".into()),
    };
    Ok(parent_matches(&commit, expected))
}
#[cfg(test)]
mod revision_tests {
    use super::*;
    #[test]
    fn workflow_on_another_branch_is_not_pr_ci_even_with_the_same_sha() {
        let revisions = vec!["source".into(), "merge".into()];
        assert!(!github_run_matches(
            &json!({"headBranch":"other","headSha":"source"}),
            "topic",
            &revisions
        ));
        assert!(!github_run_matches(
            &json!({"headBranch":"topic","headSha":"old"}),
            "topic",
            &revisions
        ));
        assert!(github_run_matches(
            &json!({"headBranch":"topic","headSha":"merge"}),
            "topic",
            &revisions
        ));
    }
    #[test]
    fn merge_parents_must_include_the_current_pr_source() {
        assert!(parent_matches(
            &json!({"parents":[{"sha":"base"},{"sha":"current"}]}),
            "current"
        ));
        assert!(parent_matches(
            &json!({"parent_ids":["base","current"]}),
            "current"
        ));
        assert!(parent_matches(
            &json!({"parents":["base","current"]}),
            "current"
        ));
        assert!(!parent_matches(
            &json!({"parents":["base","old-source"]}),
            "current"
        ));
        assert!(!parent_matches(&json!({}), "current"));
    }
}
