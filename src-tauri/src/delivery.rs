//! Task-scoped delivery. Public commands accept recorded repo selectors, never arbitrary paths.
use crate::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub dir_name: String,
    pub path: String,
    pub branch: String,
    pub head: String,
    pub remote: String,
    pub worktree: String,
    #[serde(default)]
    pub pr_number: Option<u64>,
    #[serde(default)]
    pub pr_revision: Option<String>,
}
#[derive(Serialize)]
pub struct Repo {
    pub dir_name: String,
    pub name: String,
    pub mode: String,
    pub base: String,
    pub dirty: bool,
    pub changed: Option<bool>,
    pub identity: Option<Identity>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct CiNode {
    pub id: String,
    pub parent: Option<String>,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub duration: Option<f64>,
    pub url: String,
    pub log_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ThreadComment {
    pub id: String,
    pub author: String,
    pub body: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ReviewThread {
    pub id: String,
    pub reply_id: String,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub resolved: Option<bool>,
    pub url: String,
    pub comments: Vec<ThreadComment>,
}
#[derive(Serialize)]
pub struct Details {
    pub identity: Identity,
    pub pr: forge::PrStatus,
    pub revision: String,
    pub ci: Vec<CiNode>,
    pub ci_error: Option<String>,
    pub threads: Vec<ReviewThread>,
    pub threads_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Draft {
    pub key: String,
    pub dir_name: String,
    pub pr_number: u64,
    pub thread_id: String,
    pub reply_id: String,
    pub body: String,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PrText {
    pub dir_name: String,
    pub title: String,
    pub body: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub identities: Vec<Identity>,
    #[serde(default)]
    pub report: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub kind: String,
    /// Human-readable "what this request covers" — repo names plus the
    /// evidence items (check names, thread paths) selected at send time.
    /// Display-only; evidence itself is embedded in the prompt text.
    #[serde(default)]
    pub scope: String,
    /// Selected evidence item key → canonical JSON captured at request time.
    /// Compared against a fresh provider probe before send so a comment
    /// edited or a check re-run between review and send is caught instead
    /// of silently handed to the agent.
    #[serde(default)]
    pub evidence: std::collections::HashMap<String, String>,
    /// Terminal tab the prompt was queued to or sent in — lets the request
    /// card jump straight to the working agent.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub drafts: Vec<Draft>,
    #[serde(default)]
    pub prs: Vec<PrText>,
}
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    requests: Vec<Request>,
    #[serde(default)]
    results: Vec<ActionResult>,
}
#[derive(Deserialize)]
pub struct PrInput {
    pub identity: Identity,
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
}
#[derive(Serialize, Deserialize)]
pub struct ActionResult {
    pub dir_name: String,
    pub name: String,
    /// "pr" | "update" — a repo can legitimately hold one row of each
    /// (a conflicted update and a failed PR create); `store_results`
    /// replaces only same-action rows for a directory.
    #[serde(default)]
    pub action: String,
    pub url: Option<String>,
    pub result: Option<UpdateResult>,
    pub error: Option<String>,
}
// ponytail: serialize delivery mutations, use per-task locks if bulk throughput matters.
static LOCK: Mutex<()> = Mutex::new(());

fn task(id: &str) -> Result<Task, String> {
    load_tasks_all()
        .into_iter()
        .find(|w| w.id == id && !w.archived)
        .ok_or_else(|| "Task is missing or archived".into())
}
fn fingerprint(cwd: &Path) -> Result<String, String> {
    let status = git(&["status", "--porcelain", "-uall"], cwd).map_err(|e| e.to_string())?;
    let diff = git(&["diff", "--binary", "HEAD"], cwd).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    // `.termic-delivery` is report scratch: it appears as untracked until the
    // request that created it writes its info/exclude line, and must not move
    // the fingerprint underneath the identities captured in between.
    hash.update(
        status
            .lines()
            .filter(|l| {
                !(l.starts_with("?? ")
                    && (&l[3..] == ".termic-delivery" || l[3..].starts_with(".termic-delivery/")))
            })
            .collect::<Vec<_>>()
            .join("\n"),
    );
    hash.update(diff.as_bytes());
    // ponytail: untracked metadata detects ordinary edits; hash contents if same-size/same-mtime edits become a real gap.
    for p in git(&["ls-files", "--others", "--exclude-standard", "-z"], cwd)
        .map_err(|e| e.to_string())?
        .split('\0')
        .filter(|p| {
            !p.is_empty() && *p != ".termic-delivery" && !p.starts_with(".termic-delivery/")
        })
    {
        if let Ok(m) = fs::symlink_metadata(cwd.join(p)) {
            hash.update(m.len().to_le_bytes());
            hash.update(format!("{:?}", m.modified()).as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn identity(w: &Task, dir: &str) -> Result<Identity, String> {
    let cwd = repo_cwd(w, dir)?;
    let path = dunce::canonicalize(&cwd).map_err(|e| format!("Checkout missing: {e}"))?;
    let branch = git(&["branch", "--show-current"], &path)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    let head = git(&["rev-parse", "HEAD"], &path)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    let remote = git(&["remote", "get-url", &detect_default_remote(&path)], &path)
        .map(|s| forge::remote_for_display(s.trim()))
        .unwrap_or_default();
    Ok(Identity {
        dir_name: dir.into(),
        path: path.to_string_lossy().into_owned(),
        branch,
        head,
        remote,
        worktree: fingerprint(&path)?,
        pr_number: None,
        pr_revision: None,
    })
}
fn validate(id: &str, expected: &Identity) -> Result<(Task, PathBuf), String> {
    let w = task(id)?;
    let mut current = identity(&w, &expected.dir_name)?;
    if let Some(number) = expected.pr_number {
        let pr = pr_for(&w, Path::new(&current.path), &expected.dir_name)?;
        if pr.number != number {
            return Err("PR changed. Review again.".into());
        }
        current.pr_number = Some(number);
        current.pr_revision = Some(forge::delivery::revision(
            &pr.provider,
            Path::new(&current.path),
            number,
        )?);
    }
    if &current != expected {
        return Err(
            "Repository, branch, revision, or working files changed. Refresh and review again."
                .into(),
        );
    }
    Ok((w, PathBuf::from(&current.path)))
}
fn known<'a>(w: &'a Task, dir: &str) -> (Option<&'a str>, Option<u64>) {
    if dir.is_empty() {
        (w.pr_provider.as_deref(), w.pr_number)
    } else {
        w.composition
            .iter()
            .find(|m| m.dir_name == dir)
            .map(|m| (m.pr_provider.as_deref(), m.pr_number))
            .unwrap_or_default()
    }
}
fn lookup(w: &Task, cwd: &Path, dir: &str) -> PrLookup {
    let (p, n) = known(w, dir);
    pr_lookup_at(cwd, n, p)
}
fn pr_for(w: &Task, cwd: &Path, dir: &str) -> Result<forge::PrStatus, String> {
    let l = lookup(w, cwd, dir);
    if l.status != "ok" {
        return Err(l.message);
    }
    l.pr.ok_or_else(|| "No PR for this branch".into())
}
fn persist_pr(id: &str, dir: &str, p: &forge::PrStatus) -> Result<(), String> {
    let mut w = task(id)?;
    if dir.is_empty() {
        w.pr_url = Some(p.url.clone());
        w.pr_number = Some(p.number);
        w.pr_provider = Some(p.provider.clone());
    } else if let Some(m) = w.composition.iter_mut().find(|m| m.dir_name == dir) {
        m.pr_url = Some(p.url.clone());
        m.pr_number = Some(p.number);
        m.pr_provider = Some(p.provider.clone());
    } else {
        return Err("Repository removed from task".into());
    }
    save_task(&w).map_err(|e| e.to_string())
}
fn saved_path(id: &str) -> Result<PathBuf, String> {
    task(id)?;
    Ok(scratch_dir(id)?.join("delivery.json"))
}
fn load(id: &str) -> Result<Saved, String> {
    let path = saved_path(id)?;
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(s) => Ok(s),
            // A torn write or hand-edit would otherwise hard-error every
            // delivery command forever — park the unreadable file next to
            // the original and start with an empty store instead.
            Err(_) => {
                let _ = fs::rename(&path, path.with_extension("corrupt.json"));
                Ok(Saved::default())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn save(id: &str, s: &Saved) -> Result<(), String> {
    write_atomic(
        &saved_path(id)?,
        &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn safe_report(w: &Task, r: &Request) -> Result<PathBuf, String> {
    let root = dunce::canonicalize(&w.path).map_err(|e| e.to_string())?;
    let path = root.join(".termic-delivery").join(format!("{}.json", r.id));
    if path.to_string_lossy() != r.report {
        return Err("Report checkout changed".into());
    }
    if !path.parent().ok_or("missing parent")?.exists() {
        return Ok(path);
    }
    let parent =
        dunce::canonicalize(path.parent().ok_or("missing parent")?).map_err(|e| e.to_string())?;
    // A regular file at .termic-delivery canonicalizes to itself and passes
    // the path check — without this, every poll silently finds no report.
    if !parent.is_dir() {
        return Err(".termic-delivery is not a directory".into());
    }
    if parent != root.join(".termic-delivery") {
        return Err("Report directory escapes the task".into());
    }
    if fs::symlink_metadata(&path)
        .map(|m| !m.is_file() || m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Report must be a regular file".into());
    }
    Ok(path)
}
fn dirs(w: &Task) -> Vec<(String, String, String)> {
    let mut out = vec![(
        String::new(),
        load_projects_all()
            .iter()
            .find(|p| p.id == w.project_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| w.name.clone()),
        if w.is_main_checkout {
            "repo_root"
        } else {
            "worktree"
        }
        .into(),
    )];
    out.extend(w.composition.iter().map(|m| {
        (
            m.dir_name.clone(),
            m.dir_name.clone(),
            match m.mode {
                MemberMode::RepoRoot => "repo_root",
                MemberMode::Worktree => "worktree",
            }
            .into(),
        )
    }));
    out
}
fn repos(id: &str) -> Result<Vec<Repo>, String> {
    let w = task(id)?;
    let projects = load_projects_all();
    Ok(dirs(&w)
        .into_iter()
        .map(|(dir, name, mode)| {
            let base = repo_base_branch(&w, &dir, &projects);
            match identity(&w, &dir) {
                Ok(i) => {
                    let cwd = Path::new(&i.path);
                    let dirty = git(&["status", "--porcelain", "-uall"], cwd)
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(true);
                    // A boolean only: merge-base + name-only is two cheap
                    // reads, not git_compare's full stat walk (which reads up
                    // to 8 MiB of untracked files per repo per refresh). When
                    // the worktree is dirty the UI shows that instead and
                    // archive_ready rejects on `dirty` first, so skip.
                    let changed = if base.is_empty() || dirty {
                        None
                    } else {
                        git(&["merge-base", &base, "HEAD"], cwd)
                            .ok()
                            .and_then(|mb| {
                                git(&["--no-pager", "diff", "--name-only", "-M", mb.trim()], cwd)
                                    .ok()
                            })
                            .map(|s| !s.trim().is_empty())
                    };
                    Repo {
                        dir_name: dir,
                        name,
                        mode,
                        base,
                        dirty,
                        changed,
                        identity: Some(i),
                        error: None,
                    }
                }
                Err(e) => Repo {
                    dir_name: dir,
                    name,
                    mode,
                    base,
                    dirty: false,
                    changed: None,
                    identity: None,
                    error: Some(e),
                },
            }
        })
        .collect())
}
fn details(id: &str, expected: Identity) -> Result<Details, String> {
    let (w, cwd) = validate(id, &expected)?;
    let pr = pr_for(&w, &cwd, &expected.dir_name)?;
    let revision = forge::delivery::revision(&pr.provider, &cwd, pr.number)?;
    let ci = forge::delivery::ci(&pr.provider, &cwd, pr.number, &revision);
    let threads = forge::delivery::threads(&pr.provider, &cwd, pr.number);
    validate(id, &expected)?;
    if forge::delivery::revision(&pr.provider, &cwd, pr.number)? != revision {
        return Err("PR revision changed. Refresh.".into());
    }
    Ok(Details {
        identity: expected,
        pr,
        revision,
        ci_error: ci.as_ref().err().cloned(),
        ci: ci.unwrap_or_default(),
        threads_error: threads.as_ref().err().cloned(),
        threads: threads.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn task_delivery_repos(id: String) -> Result<Vec<Repo>, String> {
    tauri::async_runtime::spawn_blocking(move || repos(&id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_details(id: String, expected: Identity) -> Result<Details, String> {
    tauri::async_runtime::spawn_blocking(move || details(&id, expected))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_validate(id: String, expected: Vec<Identity>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for i in expected {
            validate(&id, &i)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_log(
    id: String,
    expected: Identity,
    log_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = details(&id, expected.clone())?;
        if !d.ci.iter().any(|n| n.log_id.as_deref() == Some(&log_id)) {
            return Err("Log no longer belongs to this PR revision".into());
        }
        let result = forge::delivery::log(&d.pr.provider, Path::new(&expected.path), &log_id)?;
        validate(&id, &expected)?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Import one request's report file. `Ok(None)` = no report on disk yet;
/// `Ok(Some(mutated))` = the file was read and applied (or had nothing new).
/// `Err` leaves the request untouched - the caller records it on that one
/// request so a malformed report cannot wedge every other request's listing.
fn import_report(w: &Task, r: &mut Request) -> Result<Option<bool>, String> {
    let path = safe_report(w, r)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_report(&path)?;
    let report = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| "Report is not valid JSON".to_string())?;
    if !report.is_object() {
        return Err("Report must be a JSON object".into());
    }
    let mut mutated = false;
    // Validate BOTH lists fully before mutating anything: drafts only fill
    // empty bodies, so a report that applied its first items then errored
    // on a later one could never be repaired by a corrected rewrite.
    let mut staged_drafts: Option<Vec<(&str, &str)>> = None;
    if let Some(v) = report.get("drafts") {
        let list = v.as_array().ok_or("Report drafts must be an array")?;
        let mut seen = HashSet::new();
        let mut staged = Vec::with_capacity(list.len());
        for item in list {
            let key = item["key"].as_str().ok_or("Draft report has no item key")?;
            let body = item["body"].as_str().ok_or("Draft report has no body")?;
            if body.len() > 32000 {
                return Err("Draft reply exceeds 32,000 bytes".into());
            }
            if !seen.insert(key) {
                return Err("Duplicate draft item".into());
            }
            if !r.drafts.iter().any(|d| d.key == key) {
                return Err("Draft report contains an unrequested thread".into());
            }
            staged.push((key, body));
        }
        staged_drafts = Some(staged);
    }
    let mut staged_prs: Option<Vec<PrText>> = None;
    if let Some(v) = report.get("prs") {
        let list = v.as_array().ok_or("Report prs must be an array")?;
        if !list.is_empty() && r.kind != "prs" {
            return Err("Unexpected PR drafts in report".into());
        }
        let mut seen = HashSet::new();
        let mut staged = Vec::with_capacity(list.len());
        for item in list {
            let dir = item["dir_name"]
                .as_str()
                .ok_or("PR draft has no repository selector")?;
            if !seen.insert(dir) {
                return Err("Duplicate PR draft".into());
            }
            if !r.identities.iter().any(|i| i.dir_name == dir) {
                return Err("PR report contains an unrequested repository".into());
            }
            let title = item["title"].as_str().ok_or("PR draft has no title")?;
            let body = item["body"].as_str().ok_or("PR draft has no body")?;
            if title.len() > 1000 || body.len() > 32000 {
                return Err("PR draft is too large".into());
            }
            staged.push(PrText {
                dir_name: dir.into(),
                title: title.into(),
                body: body.into(),
            });
        }
        staged_prs = Some(staged);
    }
    // Both lists validated — apply.
    if let Some(staged) = staged_drafts {
        for (key, body) in staged {
            let Some(d) = r.drafts.iter_mut().find(|d| d.key == key) else {
                continue;
            };
            if d.status == "draft" && d.body.is_empty() {
                d.body = body.into();
                mutated = true;
            }
        }
    }
    if let Some(staged) = staged_prs {
        for p in staged {
            r.prs.retain(|x| x.dir_name != p.dir_name);
            r.prs.push(p);
            mutated = true;
        }
    }
    // An explicit (even empty) "prs"/"drafts" list is a delivered report —
    // the agent answered, it just had nothing to fill. A report lacking the
    // key entirely is still "waiting".
    if r.kind == "prs" && r.prs.is_empty() && report.get("prs").is_none() {
        return Ok(Some(mutated));
    }
    // Only 'replies' requests make the drafts list mandatory — 'fix' drafts
    // are opportunistic extras (the prompt asks for reply text where a
    // thread was fixed, but the fix itself is the deliverable).
    if r.kind == "replies"
        && r.drafts.iter().any(|d| d.body.is_empty())
        && report.get("drafts").is_none()
    {
        return Ok(Some(mutated));
    }
    r.status = "drafted".into();
    Ok(Some(true))
}

#[tauri::command]
pub async fn task_delivery_requests(id: String) -> Result<Vec<Request>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        let w = task(&id)?;
        let mut data = load(&id)?;
        let mut changed = false;
        for r in &mut data.requests {
            if !matches!(r.status.as_str(), "sent" | "queued" | "uncertain") {
                continue;
            }
            match import_report(&w, r) {
                // An unread report leaves any send-time error alone; a read
                // report resolves whatever import error preceded it.
                Ok(None) => {}
                Ok(Some(mutated)) => {
                    changed |= mutated;
                    if r.error.take().is_some() {
                        changed = true;
                    }
                }
                Err(e) => {
                    if r.error.as_deref() != Some(e.as_str()) {
                        r.error = Some(e);
                        changed = true;
                    }
                }
            }
        }
        if changed {
            save(&id, &data)?;
        }
        Ok(data.requests)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Split `${dir}:${ci|review}:${id}` — dir names may contain ':', so the
/// repository is matched as the LONGEST prefix (dirs "a" and "a:b" listed
/// together must resolve key "a:b:ci:x" to "a:b", not first-listed "a").
fn parse_evidence_key<'a, 'b>(
    expected: &'a [Identity],
    key: &'b str,
) -> Result<(&'a Identity, &'b str, &'b str), String> {
    let i = expected
        .iter()
        .filter(|i| key.starts_with(&format!("{}:", i.dir_name)))
        .max_by_key(|i| i.dir_name.len())
        .ok_or("Evidence repository not selected")?;
    let rest = &key[i.dir_name.len() + 1..];
    let (which, item) = rest.split_once(':').ok_or("Malformed evidence key")?;
    Ok((i, which, item))
}

/// Canonical JSON of one evidence item in a fresh probe — `None` when the
/// id no longer exists (or `which` is neither "ci" nor "review").
fn evidence_json(det: &Details, which: &str, item: &str) -> Option<String> {
    match which {
        "ci" => det
            .ci
            .iter()
            .find(|n| n.id == item)
            .and_then(|n| serde_json::to_string(n).ok()),
        "review" => det
            .threads
            .iter()
            .find(|t| t.id == item)
            .and_then(|t| serde_json::to_string(t).ok()),
        _ => None,
    }
}

/// Serialize the selected evidence items (key → canonical JSON of the CI
/// node or review thread). A fresh probe at send time compares against
/// this snapshot — anything edited or re-run in between fails the send.
fn collect_evidence(
    id: &str,
    expected: &[Identity],
    evidence_keys: &[String],
    cache: &mut HashMap<String, Details>,
) -> Result<HashMap<String, String>, String> {
    if evidence_keys.len() > 200 {
        return Err("Select at most 200 evidence items".into());
    }
    let mut out = HashMap::new();
    for key in evidence_keys {
        let (i, which, item) = parse_evidence_key(expected, key)?;
        if !cache.contains_key(&i.dir_name) {
            cache.insert(i.dir_name.clone(), details(id, i.clone())?);
        }
        let det = &cache[&i.dir_name];
        // A failed probe leaves its half empty — surface the real probe
        // error rather than reporting every item as deleted.
        let probe_error = match which {
            "ci" => &det.ci_error,
            "review" => &det.threads_error,
            _ => &None,
        };
        if let Some(e) = probe_error {
            return Err(e.clone());
        }
        let json = evidence_json(det, which, item)
            .ok_or("Evidence item is gone. Refresh and select again.")?;
        out.insert(key.clone(), json);
    }
    Ok(out)
}

/// Validate reply drafts against a live provider probe, populating the
/// shared details cache for reuse by evidence collection.
fn check_drafts(
    id: &str,
    expected: &[Identity],
    drafts: &[Draft],
    cache: &mut HashMap<String, Details>,
) -> Result<(), String> {
    let mut keys = HashSet::new();
    for d in drafts {
        if !keys.insert(&d.key) {
            return Err("Duplicate draft item".into());
        }
        let i = expected
            .iter()
            .find(|i| i.dir_name == d.dir_name)
            .ok_or("Draft repository not selected")?;
        if !cache.contains_key(&d.dir_name) {
            cache.insert(d.dir_name.clone(), details(id, i.clone())?);
        }
        let det = &cache[&d.dir_name];
        if let Some(e) = &det.threads_error {
            return Err(e.clone());
        }
        if det.pr.number != d.pr_number
            || !det
                .threads
                .iter()
                .any(|t| t.id == d.thread_id && t.reply_id == d.reply_id)
        {
            return Err("Review thread changed. Refresh.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn task_delivery_request(
    id: String,
    expected: Vec<Identity>,
    drafts: Vec<Draft>,
    kind: String,
    scope: Option<String>,
    evidence_keys: Vec<String>,
) -> Result<Request, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        if expected.is_empty() || expected.len() > 64 || drafts.len() > 100 {
            return Err("Select 1-64 repositories and at most 100 threads".into());
        }
        if !["fix", "replies", "prs", "conflicts"].contains(&kind.as_str()) {
            return Err("Invalid request kind".into());
        }
        let w = task(&id)?;
        let mut selected = HashSet::new();
        for i in &expected {
            if !selected.insert(&i.dir_name) {
                return Err("Duplicate repository selection".into());
            }
        }
        for i in &expected {
            validate(&id, i)?;
        }
        let mut details_cache = HashMap::new();
        check_drafts(&id, &expected, &drafts, &mut details_cache)?;
        let evidence = collect_evidence(&id, &expected, &evidence_keys, &mut details_cache)?;
        let root = dunce::canonicalize(&w.path).map_err(|e| e.to_string())?;
        let dir = root.join(".termic-delivery");
        if let Ok(m) = fs::symlink_metadata(&dir) {
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err("Report directory must be a real task directory".into());
            }
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // A symlink planted between the check and the create could aim the
        // report dir outside the worktree; re-verify after create.
        if dunce::canonicalize(&dir).map_err(|e| e.to_string())? != root.join(".termic-delivery") {
            return Err("Report directory escapes the task".into());
        }
        // git's own common-dir resolver works for .git FILES in worktrees.
        {
            let common =
                git(&["rev-parse", "--git-common-dir"], &root).map_err(|e| e.to_string())?;
            let common = root.join(common.trim());
            let file = common.join("info/exclude");
            let mut body = fs::read_to_string(&file).unwrap_or_default();
            if !body.lines().any(|l| l == "/.termic-delivery/") {
                if !body.ends_with('\n') {
                    body.push('\n');
                }
                body.push_str("/.termic-delivery/\n");
                write_atomic(&file, body.as_bytes()).map_err(|e| e.to_string())?;
            }
            git(&["check-ignore", ".termic-delivery/report.json"], &root)
                .map_err(|_| "Report directory could not be ignored")?;
        }
        let request_id = Uuid::new_v4().to_string();
        let r = Request {
            id: request_id.clone(),
            kind,
            identities: expected,
            report: dir
                .join(format!("{request_id}.json"))
                .to_string_lossy()
                .into_owned(),
            status: "prepared".into(),
            error: None,
            // Display-only label; cap so a hostile selection can't bloat the
            // durable file.
            scope: scope.unwrap_or_default().chars().take(500).collect(),
            evidence,
            drafts: drafts
                .into_iter()
                .map(|mut d| {
                    d.body.clear();
                    d.status = "draft".into();
                    d.error = None;
                    d
                })
                .collect(),
            prs: vec![],
            agent: None,
        };
        let mut data = load(&id)?;
        data.requests.push(r.clone());
        // Bound the durable log — evidence snapshots embed thread bodies,
        // so the file grows with every send otherwise. Requests append in
        // order, so this drops the oldest finished ones past the cap;
        // active requests are never pruned.
        if data.requests.len() > 200 {
            let mut excess = data.requests.len() - 200;
            data.requests.retain(|r| {
                if excess > 0 && matches!(r.status.as_str(), "drafted" | "failed") {
                    excess -= 1;
                    false
                } else {
                    true
                }
            });
        }
        save(&id, &data)?;
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Re-probe the request's evidence items and prove they are unchanged since
/// the user reviewed them — a thread edited or a check re-run in between
/// means the prompt no longer matches what was approved.
#[tauri::command]
pub async fn task_delivery_request_check(id: String, request_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // load() may rename a corrupt file — that write needs the mutation
        // lock so a concurrent save can't be moved aside underneath it.
        // The provider probe itself stays lock-free: a wedged mutating
        // command elsewhere must not stall send checks.
        task(&id)?;
        let data = {
            let _guard = LOCK.lock();
            load(&id)?
        };
        let r = data
            .requests
            .iter()
            .find(|r| r.id == request_id)
            .ok_or("Request is gone")?;
        if r.evidence.is_empty() {
            return Ok(());
        }
        let mut cache = HashMap::new();
        for (key, expected_json) in &r.evidence {
            let (i, which, item) = parse_evidence_key(&r.identities, key)?;
            if !cache.contains_key(&i.dir_name) {
                cache.insert(i.dir_name.clone(), details(&id, i.clone())?);
            }
            let det = &cache[&i.dir_name];
            // A probe outage empties its half of the detail — surface the
            // real error, not "item gone".
            let probe_error = match which {
                "ci" => &det.ci_error,
                "review" => &det.threads_error,
                _ => &None,
            };
            if let Some(e) = probe_error {
                return Err(e.clone());
            }
            let fresh = evidence_json(det, which, item).ok_or_else(|| {
                format!("Evidence item is gone ({}). Refresh and send again.", key)
            })?;
            if &fresh != expected_json {
                return Err("Evidence changed since review. Refresh and send again.".into());
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Rewrite a still-prepared request's drafts/evidence/scope — the send
/// dialog's item picker adjusts coverage before dispatch. Anything beyond
/// `prepared` is immutable: a queued or sent prompt must match its request.
#[tauri::command]
pub async fn task_delivery_request_amend(
    id: String,
    request_id: String,
    drafts: Vec<Draft>,
    evidence_keys: Vec<String>,
    scope: Option<String>,
) -> Result<Request, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        task(&id)?;
        let mut data = load(&id)?;
        let idx = data
            .requests
            .iter()
            .position(|r| r.id == request_id)
            .ok_or("Request is gone")?;
        if data.requests[idx].status != "prepared" {
            return Err("Request already left the dialog".into());
        }
        if drafts.len() > 100 {
            return Err("Select at most 100 threads".into());
        }
        let expected = data.requests[idx].identities.clone();
        let mut details_cache = HashMap::new();
        check_drafts(&id, &expected, &drafts, &mut details_cache)?;
        let mut evidence = collect_evidence(&id, &expected, &evidence_keys, &mut details_cache)?;
        let r = &mut data.requests[idx];
        // Keys the user already reviewed keep their original snapshot — the
        // send-time check must compare against what was approved, not a
        // silently re-baselined probe. Only items newly added in the picker
        // take a fresh snapshot.
        for (k, v) in &mut evidence {
            if let Some(old) = r.evidence.get(k) {
                *v = old.clone();
            }
        }
        r.evidence = evidence;
        // Rotating the id retires stale queue copies pinned to the
        // pre-amend prompt: they fail the send-time claim with "Request is
        // gone" instead of typing the old text.
        let new_id = Uuid::new_v4().to_string();
        r.report = Path::new(&r.report)
            .with_file_name(format!("{new_id}.json"))
            .to_string_lossy()
            .into_owned();
        r.id = new_id;
        r.drafts = drafts
            .into_iter()
            .map(|mut d| {
                d.body.clear();
                d.status = "draft".into();
                d.error = None;
                d
            })
            .collect();
        r.scope = scope.unwrap_or_default().chars().take(500).collect();
        let out = r.clone();
        save(&id, &data)?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Returns the status the request was in before this call, so a sender can
/// tell "I claimed it from the state I read" apart from "a dismiss or a
/// parallel send landed in between" (both read as a successful mark
/// otherwise, since loose transitions allow e.g. failed → queued).
#[tauri::command]
pub async fn task_delivery_request_status(
    id: String,
    request_id: String,
    status: String,
    error: Option<String>,
    agent: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        if !["queued", "sent", "failed", "uncertain"].contains(&status.as_str()) {
            return Err("Invalid delivery status".into());
        }
        let mut data = load(&id)?;
        let r = data
            .requests
            .iter_mut()
            .find(|r| r.id == request_id)
            .ok_or("Unknown delivery request")?;
        // Loose transitions let a stale queue item re-"send" a request that
        // was already sent (the prompt would be typed twice). Same-status is
        // an idempotent no-op; 'drafted' is terminal except for the user's
        // explicit dismiss (failed-with-no-error is the hidden state).
        let legal = r.status == status
            || matches!(
                (r.status.as_str(), status.as_str()),
                ("prepared", "queued" | "sent" | "failed" | "uncertain")
                    | ("queued", "sent" | "failed" | "uncertain")
                    | ("sent", "failed" | "uncertain")
                    | ("uncertain", "sent" | "failed")
                    | ("failed", "queued" | "sent")
                    | ("drafted", "failed")
            );
        if !legal {
            return Err(format!(
                "Delivery request is '{}', cannot become '{status}'",
                r.status
            ));
        }
        let prev = r.status.clone();
        let same = prev == status;
        r.status = status;
        // A same-status mark is a no-op re-mark (queue drain); don't let
        // its null error wipe a recorded import/send error.
        if !(same && error.is_none()) {
            r.error = error;
        }
        if let Some(tab) = agent {
            r.agent = Some(tab);
        }
        save(&id, &data)?;
        Ok(prev)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_draft_save(
    id: String,
    request_id: String,
    key: String,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        if body.len() > 32000 {
            return Err("Reply exceeds 32,000 bytes".into());
        }
        let mut data = load(&id)?;
        let d = data
            .requests
            .iter_mut()
            .find(|r| r.id == request_id)
            .and_then(|r| r.drafts.iter_mut().find(|d| d.key == key))
            .ok_or("Unknown reply draft")?;
        if d.status != "draft" {
            return Err("Posted or uncertain reply cannot be edited".into());
        }
        d.body = body;
        save(&id, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_reply_post(
    id: String,
    request_id: String,
    key: String,
    expected: Identity,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        let (w, cwd) = validate(&id, &expected)?;
        let mut data = load(&id)?;
        let r = data
            .requests
            .iter_mut()
            .find(|r| r.id == request_id)
            .ok_or("Unknown delivery request")?;
        let original = r
            .identities
            .iter()
            .find(|i| i.dir_name == expected.dir_name)
            .ok_or("Original repository unavailable")?;
        if original.path != expected.path
            || original.remote != expected.remote
            || original.branch != expected.branch
        {
            return Err("Reply destination changed. Draft retained.".into());
        }
        let marker = format!(
            "<!-- termic-draft:{}:{:x} -->",
            r.id,
            Sha256::digest(key.as_bytes())
        );
        let d = r
            .drafts
            .iter_mut()
            .find(|d| d.key == key && d.dir_name == expected.dir_name)
            .ok_or("Unknown reply draft")?;
        if d.status == "posted" {
            return Ok(());
        }
        if d.body.trim().is_empty() {
            return Err("Reply is empty".into());
        }
        let pr = pr_for(&w, &cwd, &expected.dir_name)?;
        if pr.number != d.pr_number {
            return Err("PR changed. Reply retained.".into());
        }
        let threads = forge::delivery::threads(&pr.provider, &cwd, pr.number)?;
        let thread = threads
            .iter()
            .find(|t| t.id == d.thread_id && t.reply_id == d.reply_id)
            .ok_or("Thread no longer available. Reply retained.")?;
        if reconcile_reply_readback(d, thread, &marker) {
            save(&id, &data)?;
            return Ok(());
        }
        validate(&id, &expected)?;
        let reply = format!("{}\n\n{}", d.body, marker);
        let thread = thread.clone();
        d.status = "posting".into();
        save(&id, &data)?;
        let result = forge::delivery::post_reply(&pr.provider, &cwd, pr.number, &thread, &reply);
        let d = data
            .requests
            .iter_mut()
            .find(|r| r.id == request_id)
            .and_then(|r| r.drafts.iter_mut().find(|d| d.key == key))
            .ok_or("Reply disappeared")?;
        d.status = if result.is_ok() {
            "posted"
        } else {
            "uncertain"
        }
        .into();
        d.error = result.as_ref().err().cloned();
        save(&id, &data)?;
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_pr_create(
    id: String,
    inputs: Vec<PrInput>,
) -> Result<Vec<ActionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        if inputs.is_empty() || inputs.len() > 64 {
            return Err("Select 1-64 repositories".into());
        }
        let mut results = vec![];
        let mut seen = HashSet::new();
        for input in inputs {
            let dir = input.identity.dir_name.clone();
            // Per-item outcome, like update(): a dup mid-list must not drop
            // the results for repos already pushed/created.
            let outcome = (|| {
                if !seen.insert(dir.clone()) {
                    return Err("Duplicate repository selection".into());
                }
                let (w, cwd) = validate(&id, &input.identity)?;
                let l = lookup(&w, &cwd, &dir);
                if l.status != "ok" {
                    return Err(l.message);
                }
                if let Some(p) = l.pr {
                    if matches!(p.state.as_str(), "open" | "draft") {
                        persist_pr(&id, &dir, &p)?;
                        return Ok(p.url);
                    }
                }
                if input.identity.branch.is_empty() {
                    return Err("Detached HEAD. Check out a branch first.".into());
                }
                if !git(&["status", "--porcelain", "-uall"], &cwd)
                    .map_err(|e| e.to_string())?
                    .trim()
                    .is_empty()
                {
                    return Err("Commit or discard local changes before creating a PR.".into());
                }
                let base = input.base.trim();
                if base.is_empty() || input.title.trim().is_empty() {
                    return Err("Title and base branch are required".into());
                }
                if git_compare(&cwd, base, true)
                    .map_err(|e| e.to_string())?
                    .files
                    .is_empty()
                {
                    return Err("No branch changes against the selected base. Skipped.".into());
                }
                let provider = l.provider.ok_or("Unsupported provider")?;
                let remote = detect_default_remote(&cwd);
                let prefix = format!("{remote}/");
                let base = base.strip_prefix(&prefix).unwrap_or(base);
                validate(&id, &input.identity)?;
                git_push(&cwd)?;
                validate(&id, &input.identity)?;
                let url = forge::pr_create(
                    &provider,
                    &cwd,
                    input.title.trim(),
                    input.body.trim(),
                    base,
                    input.draft,
                )
                .map_err(|e| e.to_string())?;
                let number = forge::pr_number_from_url(&url).ok_or(
                    "Created PR URL could not be read. Open the provider before retrying.",
                )?;
                // Persist the URL even if the immediately-following status request fails.
                let p = forge::PrStatus {
                    provider,
                    number,
                    url: url.clone(),
                    title: input.title,
                    state: if input.draft { "draft" } else { "open" }.into(),
                    checks: "none".into(),
                    review: "none".into(),
                    base: base.into(),
                    head: input.identity.branch,
                };
                persist_pr(&id, &dir, &p)?;
                Ok(url)
            })();
            results.push(ActionResult {
                dir_name: dir.clone(),
                name: if dir.is_empty() { "Host".into() } else { dir },
                action: "pr".into(),
                url: outcome.as_ref().ok().cloned(),
                result: None,
                error: outcome.err(),
            });
        }
        store_results(&id, results)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_update(
    id: String,
    expected: Vec<Identity>,
    mode: UpdateMode,
) -> Result<Vec<ActionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        if expected.is_empty() || expected.len() > 64 {
            return Err("Select 1-64 repositories".into());
        }
        let mut seen = HashSet::new();
        let results = expected
            .into_iter()
            .map(|i| {
                let dir = i.dir_name.clone();
                let outcome = (|| {
                    if !seen.insert(dir.clone()) {
                        return Err("Duplicate repository selection".into());
                    }
                    let (w, cwd) = validate(&id, &i)?;
                    let base = repo_base_branch(&w, &dir, &load_projects_all());
                    git_update_repo(&cwd, mode, &base)
                })();
                ActionResult {
                    dir_name: dir.clone(),
                    name: if dir.is_empty() { "Host".into() } else { dir },
                    action: "update".into(),
                    url: None,
                    error: outcome.as_ref().err().cloned(),
                    result: outcome.ok(),
                }
            })
            .collect();
        store_results(&id, results)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_detects_tracked_edits_and_branch_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path();
        git(&["init", "-b", "main"], cwd).unwrap();
        git(&["config", "user.email", "user@example.com"], cwd).unwrap();
        git(&["config", "user.name", "alice"], cwd).unwrap();
        fs::write(cwd.join("a"), "one").unwrap();
        git(&["add", "a"], cwd).unwrap();
        git(&["commit", "-m", "initial"], cwd).unwrap();
        let w = Task {
            path: cwd.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let first = identity(&w, "").unwrap();
        fs::write(cwd.join("a"), "two").unwrap();
        let second = identity(&w, "").unwrap();
        assert_ne!(first.worktree, second.worktree);
        git(&["checkout", "-b", "other"], cwd).unwrap();
        assert_ne!(identity(&w, "").unwrap().branch, first.branch);
    }
}

#[tauri::command]
pub async fn task_delivery_results(id: String) -> Result<Vec<ActionResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock();
        Ok(load(&id)?.results)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn task_delivery_archive_ready(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let w = task(&id)?;
        if w.is_main_checkout {
            return Ok(false);
        }
        let rows = repos(&id)?;
        for row in rows {
            let Some(i) = row.identity else {
                return Ok(false);
            };
            if row.dirty || row.changed.is_none() {
                return Ok(false);
            }
            let l = lookup(&w, Path::new(&i.path), &i.dir_name);
            if l.status != "ok" {
                return Ok(false);
            }
            match l.pr {
                Some(p) if p.state == "merged" => {}
                None if row.changed == Some(false) => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn store_results(id: &str, results: Vec<ActionResult>) -> Result<Vec<ActionResult>, String> {
    let mut data = load(id)?;
    for result in results {
        // One row per (dir, action): a pr_create row must not erase a
        // still-conflicted update row for the same repo, or the conflicts
        // handoff loses its evidence. Legacy rows carry no action and are
        // replaced by the next write for their dir.
        data.results.retain(|r| {
            !(r.dir_name == result.dir_name && (r.action == result.action || r.action.is_empty()))
        });
        data.results.push(result);
    }
    save(id, &data)?;
    Ok(data.results)
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::test_support::with_scratch_data_dir;

    #[test]
    fn reports_are_local_scoped_and_results_survive_reload() {
        with_scratch_data_dir(|_| {
            let checkout = tempfile::tempdir().unwrap();
            let root = checkout.path();
            git(&["init", "-b", "main"], root).unwrap();
            git(&["config", "user.email", "fixture@example.test"], root).unwrap();
            git(&["config", "user.name", "Fixture"], root).unwrap();
            fs::write(root.join("README.md"), "fixture").unwrap();
            git(&["add", "README.md"], root).unwrap();
            git(&["commit", "-m", "fixture"], root).unwrap();
            let w = Task {
                id: Uuid::new_v4().to_string(),
                name: "Fixture".into(),
                path: root.to_string_lossy().into_owned(),
                ..Default::default()
            };
            save_task(&w).unwrap();
            let reviewed = identity(&w, "").unwrap();
            let request = tauri::async_runtime::block_on(task_delivery_request(
                w.id.clone(),
                vec![reviewed.clone()],
                vec![],
                "prs".into(),
                Some("app".into()),
                vec![],
            ))
            .unwrap();
            assert_eq!(
                identity(&w, "").unwrap(),
                reviewed,
                "ignored reports must not invalidate the preview"
            );
            tauri::async_runtime::block_on(task_delivery_request_status(
                w.id.clone(),
                request.id.clone(),
                "sent".into(),
                None,
                None,
            ))
            .unwrap();
            fs::write(
                &request.report,
                r#"{"prs":[{"dir_name":"outside","title":"wrong","body":""}]}"#,
            )
            .unwrap();
            // A malformed report must not fail the listing: it lands on the
            // offending request and leaves the status alone so a corrected
            // rewrite still imports.
            let listed =
                tauri::async_runtime::block_on(task_delivery_requests(w.id.clone())).unwrap();
            assert_eq!(
                listed[0].error.as_deref(),
                Some("PR report contains an unrequested repository")
            );
            assert_eq!(listed[0].status, "sent");
            assert!(listed[0].prs.is_empty());
            fs::write(&request.report, r#"{"prs":[{"dir_name":"","title":"Reviewed title","body":"Proposed body"}],"drafts":[]}"#).unwrap();
            let imported =
                tauri::async_runtime::block_on(task_delivery_requests(w.id.clone())).unwrap();
            assert_eq!(imported[0].prs[0].title, "Reviewed title");
            assert_eq!(imported[0].status, "drafted");
            assert_eq!(imported[0].error, None);
            assert!(
                task(&w.id).unwrap().pr_number.is_none(),
                "import does not create or persist a PR"
            );
            store_results(
                &w.id,
                vec![ActionResult {
                    dir_name: "".into(),
                    name: "Host".into(),
                    action: "pr".into(),
                    url: Some("https://example.test/pull/7".into()),
                    result: None,
                    error: None,
                }],
            )
            .unwrap();
            store_results(
                &w.id,
                vec![ActionResult {
                    dir_name: "api".into(),
                    name: "api".into(),
                    action: "update".into(),
                    url: None,
                    result: None,
                    error: Some("offline".into()),
                }],
            )
            .unwrap();
            assert_eq!(
                load(&w.id).unwrap().results.len(),
                2,
                "retrying selected repos keeps other results"
            );
            fs::write(root.join("README.md"), "changed").unwrap();
            assert!(validate(&w.id, &reviewed).is_err());
        });
    }

    #[test]
    fn request_status_transitions_reject_re_sends_and_dead_states() {
        with_scratch_data_dir(|_| {
            let checkout = tempfile::tempdir().unwrap();
            let root = checkout.path();
            git(&["init", "-b", "main"], root).unwrap();
            git(&["config", "user.email", "fixture@example.test"], root).unwrap();
            git(&["config", "user.name", "Fixture"], root).unwrap();
            fs::write(root.join("README.md"), "fixture").unwrap();
            git(&["add", "README.md"], root).unwrap();
            git(&["commit", "-m", "fixture"], root).unwrap();
            let w = Task {
                id: Uuid::new_v4().to_string(),
                name: "Fixture".into(),
                path: root.to_string_lossy().into_owned(),
                ..Default::default()
            };
            save_task(&w).unwrap();
            let request = tauri::async_runtime::block_on(task_delivery_request(
                w.id.clone(),
                vec![identity(&w, "").unwrap()],
                vec![],
                "prs".into(),
                None,
                vec![],
            ))
            .unwrap();
            let set = |to: &str| {
                tauri::async_runtime::block_on(task_delivery_request_status(
                    w.id.clone(),
                    request.id.clone(),
                    to.into(),
                    None,
                    None,
                ))
            };
            set("queued").unwrap();
            set("queued").expect("same-status writes are idempotent");
            set("sent").unwrap();
            assert!(set("queued").is_err(), "a sent request cannot re-queue");
            assert!(set("sent").is_ok());
            // 'drafted' (the report-imported end state) is terminal except
            // for the user's explicit dismiss, which lands on 'failed'.
            let mut data = load(&w.id).unwrap();
            data.requests[0].status = "drafted".into();
            save(&w.id, &data).unwrap();
            assert!(set("sent").is_err());
            assert!(set("failed").is_ok(), "dismiss from drafted");
        });
    }

    #[test]
    fn amend_rewrites_only_prepared_requests() {
        with_scratch_data_dir(|_| {
            let checkout = tempfile::tempdir().unwrap();
            let root = checkout.path();
            git(&["init", "-b", "main"], root).unwrap();
            git(&["config", "user.email", "fixture@example.test"], root).unwrap();
            git(&["config", "user.name", "Fixture"], root).unwrap();
            fs::write(root.join("README.md"), "fixture").unwrap();
            git(&["add", "README.md"], root).unwrap();
            git(&["commit", "-m", "fixture"], root).unwrap();
            let w = Task {
                id: Uuid::new_v4().to_string(),
                name: "Fixture".into(),
                path: root.to_string_lossy().into_owned(),
                ..Default::default()
            };
            save_task(&w).unwrap();
            let request = tauri::async_runtime::block_on(task_delivery_request(
                w.id.clone(),
                vec![identity(&w, "").unwrap()],
                vec![],
                "prs".into(),
                Some("old".into()),
                vec![],
            ))
            .unwrap();
            let amended = tauri::async_runtime::block_on(task_delivery_request_amend(
                w.id.clone(),
                request.id.clone(),
                vec![],
                vec![],
                Some("repo · branch".into()),
            ))
            .unwrap();
            assert_eq!(amended.scope, "repo · branch");
            assert!(amended.evidence.is_empty());
            // Amend rotates the id: a queue item or sender still holding the
            // old id must fail instead of typing the pre-amend prompt.
            assert_ne!(amended.id, request.id);
            assert!(
                tauri::async_runtime::block_on(task_delivery_request_status(
                    w.id.clone(),
                    request.id.clone(),
                    "failed".into(),
                    None,
                    None,
                ))
                .is_err(),
                "the replaced request id is gone"
            );
            tauri::async_runtime::block_on(task_delivery_request_status(
                w.id.clone(),
                amended.id.clone(),
                "sent".into(),
                None,
                None,
            ))
            .unwrap();
            assert!(
                tauri::async_runtime::block_on(task_delivery_request_amend(
                    w.id.clone(),
                    amended.id.clone(),
                    vec![],
                    vec![],
                    Some("too late".into()),
                ))
                .is_err(),
                "a sent request's evidence is immutable"
            );
            assert_eq!(load(&w.id).unwrap().requests[0].scope, "repo · branch");
            // Empty evidence snapshots always pass the send-time check.
            tauri::async_runtime::block_on(task_delivery_request_check(
                w.id.clone(),
                amended.id.clone(),
            ))
            .unwrap();
            assert!(tauri::async_runtime::block_on(task_delivery_request_check(
                w.id.clone(),
                "missing".into(),
            ))
            .is_err());
        });
    }

    #[test]
    fn import_report_rejects_unrequested_content_and_keeps_local_edits() {
        let checkout = tempfile::tempdir().unwrap();
        // safe_report compares the stored path against the CANONICAL task
        // root — /var/… resolves to /private/var/… on macOS.
        let root = dunce::canonicalize(checkout.path()).unwrap();
        let w = Task {
            path: root.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let dir = root.join(".termic-delivery");
        fs::create_dir_all(&dir).unwrap();
        let draft = |key: &str, body: &str| Draft {
            key: key.into(),
            dir_name: String::new(),
            pr_number: 1,
            thread_id: "t".into(),
            reply_id: "x".into(),
            body: body.into(),
            status: "draft".into(),
            error: None,
        };
        let mut r = Request {
            id: "r1".into(),
            identities: vec![],
            report: dir.join("r1.json").to_string_lossy().into_owned(),
            status: "sent".into(),
            error: None,
            kind: "replies".into(),
            drafts: vec![draft("a", ""), draft("b", "local edit")],
            prs: vec![],
            scope: String::new(),
            evidence: HashMap::new(),
            agent: None,
        };
        // A replies report cannot smuggle PR drafts past the request kind.
        fs::write(
            dir.join("r1.json"),
            r#"{"prs":[{"dir_name":"","title":"t","body":"b"}]}"#,
        )
        .unwrap();
        assert_eq!(
            import_report(&w, &mut r).unwrap_err(),
            "Unexpected PR drafts in report"
        );
        // Reports fill empty drafts only: a body the user already saved
        // locally is not overwritten by what the agent produced.
        fs::write(
            dir.join("r1.json"),
            r#"{"drafts":[{"key":"a","body":"from agent"},{"key":"b","body":"overwrite?"}]}"#,
        )
        .unwrap();
        assert_eq!(import_report(&w, &mut r), Ok(Some(true)));
        assert_eq!(r.drafts[0].body, "from agent");
        assert_eq!(r.drafts[1].body, "local edit");
        assert_eq!(r.status, "drafted");
    }

    #[test]
    fn import_report_validates_shape_and_applies_atomically() {
        let checkout = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(checkout.path()).unwrap();
        let w = Task {
            path: root.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let dir = root.join(".termic-delivery");
        fs::create_dir_all(&dir).unwrap();
        let draft = |key: &str| Draft {
            key: key.into(),
            dir_name: String::new(),
            pr_number: 1,
            thread_id: "t".into(),
            reply_id: "x".into(),
            body: String::new(),
            status: "draft".into(),
            error: None,
        };
        let request = |kind: &str, drafts: Vec<Draft>| Request {
            id: "r1".into(),
            identities: vec![],
            report: dir.join("r1.json").to_string_lossy().into_owned(),
            status: "sent".into(),
            error: None,
            kind: kind.into(),
            drafts,
            prs: vec![],
            scope: String::new(),
            evidence: HashMap::new(),
            agent: None,
        };
        // Non-object and non-array payloads are errors, not silent no-ops
        // (a bare `"ok"` used to count as a delivered report and wedge the
        // request at 'drafted' with nothing inside).
        let mut r = request("replies", vec![draft("a"), draft("b")]);
        fs::write(&r.report, r#""ok""#).unwrap();
        assert_eq!(
            import_report(&w, &mut r).unwrap_err(),
            "Report must be a JSON object"
        );
        assert_eq!(r.status, "sent");
        fs::write(&r.report, r#"{"drafts":{"a":1}}"#).unwrap();
        assert!(import_report(&w, &mut r).unwrap_err().contains("array"));
        fs::write(&r.report, r#"{"prs":"done"}"#).unwrap();
        assert!(import_report(&w, &mut r).unwrap_err().contains("array"));
        // A bad second item must not leave the first applied — the report
        // validates fully before any draft is filled, so a corrected
        // rewrite can still land (drafts only fill empty bodies).
        fs::write(
            &r.report,
            r#"{"drafts":[{"key":"a","body":"hi"},{"key":"bogus","body":"x"}]}"#,
        )
        .unwrap();
        assert!(import_report(&w, &mut r).is_err());
        assert!(r.drafts[0].body.is_empty(), "partial apply must not stick");
        fs::write(
            &r.report,
            r#"{"drafts":[{"key":"a","body":"hi"},{"key":"b","body":"yo"}]}"#,
        )
        .unwrap();
        import_report(&w, &mut r).unwrap();
        assert_eq!(r.drafts[1].body, "yo");
        assert_eq!(r.status, "drafted");
        // An explicit empty list is a delivered report — the agent answered
        // with nothing to fill; only a MISSING key still means "waiting".
        let mut pr_req = request("prs", vec![]);
        fs::write(&pr_req.report, r#"{"prs":[]}"#).unwrap();
        import_report(&w, &mut pr_req).unwrap();
        assert_eq!(pr_req.status, "drafted");
        let mut reply_req = request("replies", vec![draft("a")]);
        fs::write(&reply_req.report, r#"{"drafts":[]}"#).unwrap();
        import_report(&w, &mut reply_req).unwrap();
        assert_eq!(reply_req.status, "drafted");
        // Drafts are mandatory only for 'replies': fix/conflicts drafts are
        // optional agent extras — a report answering without one still
        // completes, while a replies report missing the key keeps waiting.
        let mut fix_req = request("fix", vec![draft("a")]);
        // A NON-empty "prs" list doesn't belong on a fix request at all.
        fs::write(
            &fix_req.report,
            r#"{"prs":[{"dir_name":"","title":"x","body":"y"}]}"#,
        )
        .unwrap();
        import_report(&w, &mut fix_req).unwrap_err();
        fs::write(
            &fix_req.report,
            r#"{"drafts":[{"key":"a","body":"fixed it"}]}"#,
        )
        .unwrap();
        import_report(&w, &mut fix_req).unwrap();
        assert_eq!(fix_req.drafts[0].body, "fixed it");
        assert_eq!(fix_req.status, "drafted");
        let mut fix_req2 = request("fix", vec![draft("a")]);
        fs::write(&fix_req2.report, r#"{"extra":true}"#).unwrap();
        import_report(&w, &mut fix_req2).unwrap();
        assert_eq!(
            fix_req2.status, "drafted",
            "fix completes on any object report"
        );
        let mut wait_req = request("replies", vec![draft("a")]);
        fs::write(&wait_req.report, r#"{"prs":[]}"#).unwrap();
        import_report(&w, &mut wait_req).unwrap();
        assert_eq!(
            wait_req.status, "sent",
            "replies still waits for its drafts key"
        );
    }

    #[test]
    fn results_are_stored_per_repo_and_action() {
        with_scratch_data_dir(|_| {
            let tmp = tempfile::tempdir().unwrap();
            let w = Task {
                id: Uuid::new_v4().to_string(),
                name: "Fixture".into(),
                path: tmp.path().to_string_lossy().into_owned(),
                ..Default::default()
            };
            save_task(&w).unwrap();
            let row = |action: &str, error: Option<&str>| ActionResult {
                dir_name: "api".into(),
                name: "api".into(),
                action: action.into(),
                url: None,
                result: None,
                error: error.map(str::to_string),
            };
            // A conflicted-update row and a failed pr_create row for the
            // same repo used to overwrite each other — both must survive.
            store_results(&w.id, vec![row("update", Some("conflict"))]).unwrap();
            store_results(&w.id, vec![row("pr", Some("offline"))]).unwrap();
            let kept = load(&w.id).unwrap().results;
            assert_eq!(kept.len(), 2, "pr and update results coexist per repo");
            // The same action still replaces its previous row.
            store_results(&w.id, vec![row("pr", Some("retry failed"))]).unwrap();
            let kept = load(&w.id).unwrap().results;
            assert_eq!(kept.len(), 2);
            assert_eq!(kept[1].error.as_deref(), Some("retry failed"));
        });
    }

    #[test]
    fn evidence_keys_resolve_the_longest_dir_prefix() {
        let id = |dir_name: &str| Identity {
            dir_name: dir_name.into(),
            path: String::new(),
            branch: String::new(),
            head: String::new(),
            remote: String::new(),
            worktree: String::new(),
            pr_number: None,
            pr_revision: None,
        };
        let ids = vec![id("a"), id("a:b"), id("")];
        // ':' is a legal dir char on unix — "a:b:ci:x" must resolve to dir
        // "a:b", not the first-listed "a" (which would split which="b").
        let (i, which, item) = parse_evidence_key(&ids, "a:b:ci:build").unwrap();
        assert_eq!(i.dir_name, "a:b");
        assert_eq!((which, item), ("ci", "build"));
        // The host repo's empty dir still resolves, and only for its own
        // prefix.
        let (i, which, item) = parse_evidence_key(&ids, ":review:t1").unwrap();
        assert_eq!(i.dir_name, "");
        assert_eq!((which, item), ("review", "t1"));
        assert!(parse_evidence_key(&ids, "nope:ci:x").is_err());
    }
}

fn read_report(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    #[cfg(unix)]
    let file = {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;
        // Pin the directory before opening its child. A replacement symlink
        // cannot redirect the report read between validation and open.
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path.parent().ok_or("Missing report parent")?)
            .map_err(|e| e.to_string())?;
        let name =
            std::ffi::CString::new(path.file_name().ok_or("Missing report name")?.as_bytes())
                .map_err(|e| e.to_string())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        unsafe { fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Report must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 {
        return Err("Draft report exceeds 256 KiB".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod report_read_tests {
    use super::*;
    #[test]
    fn oversized_report_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("report.json");
        fs::write(&path, vec![b' '; 256 * 1024 + 1]).unwrap();
        assert!(read_report(&path).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn report_symlink_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("report.json");
        fs::write(tmp.path().join("other"), b"{}").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("other"), &path).unwrap();
        assert!(read_report(&path).is_err());
    }
}

// True means this call only reconciles an earlier attempt, never posts.
fn reconcile_reply_readback(d: &mut Draft, thread: &ReviewThread, marker: &str) -> bool {
    let reply = format!("{}\n\n{}", d.body, marker);
    if thread.comments.iter().any(|c| c.body == reply) {
        d.status = "posted".into();
        d.error = None;
        return true;
    }
    if matches!(d.status.as_str(), "posting" | "uncertain") {
        d.status = "retry_ready".into();
        d.error=Some("Provider readback did not find this reply. Check the thread before explicitly retrying.".into());
        return true;
    }
    false
}
#[cfg(test)]
mod reply_tests {
    use super::*;
    #[test]
    fn readback_requires_an_explicit_second_action_and_catches_late_posts() {
        let mut d = Draft {
            key: "thread".into(),
            dir_name: "".into(),
            pr_number: 7,
            thread_id: "t".into(),
            reply_id: "1".into(),
            body: "Reviewed reply".into(),
            status: "uncertain".into(),
            error: None,
        };
        let mut thread = ReviewThread {
            id: "t".into(),
            reply_id: "1".into(),
            path: None,
            line: None,
            resolved: Some(false),
            url: String::new(),
            comments: vec![],
        };
        assert!(reconcile_reply_readback(&mut d, &thread, "<!-- marker -->"));
        assert_eq!(d.status, "retry_ready");
        assert!(
            !reconcile_reply_readback(&mut d, &thread, "<!-- marker -->"),
            "a second explicit action may post after fresh readback"
        );
        thread.comments.push(ThreadComment {
            id: "2".into(),
            author: "Fixture".into(),
            body: "Reviewed reply\n\n<!-- marker -->".into(),
        });
        assert!(reconcile_reply_readback(&mut d, &thread, "<!-- marker -->"));
        assert_eq!(d.status, "posted");
    }
}
