//! The stream's messages. JSON objects tagged by `t`, sealed one per frame.
//!
//! **Additive contract** (docs/remote.md, "Versions"): a side ignores a
//! message type it does not know (`Unknown`) and fields it does not know
//! (serde's default), every field added after v1 is optional, and the
//! hello and welcome carry a version and a capability list. A newer phone
//! talking to an older desktop turns off what the desktop lacks instead of
//! failing. Shapes are pinned by the tests at the bottom; changing one is a
//! protocol change and must bump `VERSION`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The stream protocol. Bumped only for an incompatible change, which the
/// additive contract exists to avoid.
pub const VERSION: u32 = 1;

/// A `pty_exit` reason: the host restarted onto a new build and ended this
/// PTY. A client that started it starts it again (an agent resumes its
/// session) rather than showing it exited.
pub const PTY_RESTARTED: &str = "restarted";

/// What a host can do, named in `welcome.caps`. A client only uses what is
/// listed.
pub mod caps {
    /// `tasks` snapshots.
    pub const TASKS: &str = "tasks";
    /// `call`: any CLI verb (termic-proto Request/Reply).
    pub const CALL: &str = "call";
    /// `term_open` / `term_input`: a live terminal.
    pub const TERMINAL: &str = "terminal";
    /// `keys`: keystrokes into an agent without opening its terminal.
    pub const KEYS: &str = "keys";
    /// `transcript`: the agent's turns.
    pub const TRANSCRIPT: &str = "transcript";
    /// `term_size`: the client sizes the open terminal's PTY. Only a host
    /// whose PTYs have no screen of their own offers it (termic-server); a
    /// desktop's PTY is sized by its own window, so a client follows that
    /// size instead. Its presence is how a client tells the two apart.
    pub const RESIZE: &str = "resize";
    /// `pty_open` and friends: extra terminals (a shell, a script) in a
    /// project's folder, several at once, apart from the agent's.
    pub const PTY: &str = "pty";
    /// `pty_open` PTYs belong to the host and outlive a connection; open
    /// one again by its `pid` to attach (with `seen` to skip what you have).
    pub const PTY_KEEP: &str = "pty_keep";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    /// A phone: a remote control of the host.
    Phone,
    /// Another Termic.
    Computer,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    /// The Termic desktop app.
    Desktop,
    /// A headless `termic-server`.
    Server,
    #[serde(other)]
    Other,
}

/// Client to host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// The first sealed frame. Proves the key; says who is connecting.
    Hello {
        v: u32,
        /// What the client calls itself ("Alice's iPhone").
        name: String,
        kind: ClientKind,
        #[serde(default)]
        caps: Vec<String>,
        /// A computer's own app version, for the pair's "version" column.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_version: Option<String>,
        /// A computer: what it lets the host do on IT (keeps "Lets this
        /// computer" current, as calls did before the stream).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        grant: Option<String>,
        /// A computer: its own listener port, so an address change is
        /// learned in-band.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    },
    /// Run one CLI verb. `req` is a termic-proto `Request`, unchanged.
    Call {
        id: String,
        req: Value,
        /// A computer's CLI protocol (termic-proto `PROTOCOL_VERSION`).
        /// Verbs grow fields between versions and a field the other side
        /// does not know is dropped silently, so a mismatch is refused
        /// with both versions named. A phone sends none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proto: Option<u32>,
    },
    /// Watch a task's terminal: the agent tab by default, or `tab`. One
    /// terminal per connection; opening another closes the first.
    TermOpen {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
    },
    TermClose {},
    /// Keystrokes into the open terminal, base64.
    TermInput { data: String },
    /// Size the open terminal's PTY (only to a host offering `resize`).
    /// Every client watching it gets `term_resize`.
    TermSize { cols: u16, rows: u16 },
    /// Start a program on a fresh PTY in `cwd` (a project's folder or one
    /// of its worktrees), `argv` empty for the login shell. `pid` is the
    /// client's name for it; output comes back as `pty_data` with it.
    /// On a host offering `pty_keep`, the PTY belongs to the host and
    /// outlives the connection: `pty_open` with the `pid` of one still
    /// running attaches to it instead (`argv` and `cwd` then ignored), and
    /// `seen` (bytes of its output already received) skips what the client
    /// has. `seen` also means attach only: with nothing running under the
    /// `pid` the host answers `pty_exit` rather than starting it again.
    /// Elsewhere it ends with the connection.
    PtyOpen {
        pid: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        argv: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seen: Option<u64>,
    },
    /// Keystrokes into a `pty_open` PTY, base64.
    PtyInput { pid: String, data: String },
    PtyResize { pid: String, cols: u16, rows: u16 },
    /// End it (SIGHUP, then kill).
    PtyKill { pid: String },
    /// Keystrokes into a task's agent without watching it (an answer
    /// from a list or the chat), base64.
    Keys {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        data: String,
        /// When set, the host answers with an `ack` carrying it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// The `question.id` these keys answer. The host refuses them
        /// (`ack` with ok false, message "stale") if the agent's screen no
        /// longer shows that question: an answer to a question that moved
        /// on is a guess typed into whatever came next.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        question: Option<String>,
    },
    /// Stop the agent's current turn. The host knows which key does that
    /// for which agent (Esc for claude, Ctrl-C for others).
    Interrupt {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Send the open terminal's backlog again (the client knows it missed
    /// something, e.g. it was backgrounded).
    Resync {},
    /// The agent's turns, once. The client asks again when the task's
    /// state changes; nothing is polled on the host.
    Transcript { id: String, task: String },
    /// A phone's push token (APNs on iOS, FCM on Android), sent once the
    /// person allowed notifications; an empty token unregisters. The host
    /// pushes "needs you" and "finished" to it while the phone is away.
    PushToken { platform: String, token: String },
    Ping {},
    #[serde(other)]
    Unknown,
}

/// Host to client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        v: u32,
        id: String,
        name: String,
        version: String,
        kind: HostKind,
        caps: Vec<String>,
        /// What the host lets this client do: "drive" or "reply".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        grant: Option<String>,
        /// The oldest Termic desktop this host works with (compat.rs). A
        /// client older than this says so and updates itself; a host from
        /// before minimums sends none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        needs: Option<String>,
    },
    /// Every task and its state. A full snapshot on connect and on every
    /// change, never a delta: a client that misses one gets the next.
    Tasks { tasks: Vec<TaskRow> },
    Reply { id: String, reply: Value },
    /// The terminal from scratch: its size and the retained output to
    /// replay. Sent on open, after `resync`, and when the client fell behind.
    TermReset {
        task: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
        cols: u16,
        rows: u16,
        data: String,
    },
    /// Live output, base64.
    TermData { data: String },
    /// The desktop resized the terminal (the host owns the size).
    TermResize { cols: u16, rows: u16 },
    /// The terminal ended: "exited", "archived", "closed".
    TermClosed { reason: String },
    /// Output of a `pty_open` PTY, base64. `at`: the offset of its first
    /// byte in the PTY's whole output, on the backlog an open or attach
    /// sends first (so a client after a gap knows where it is).
    PtyData {
        pid: String,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    /// A `pty_open` PTY ended, or never started (`reason` says why).
    PtyExit { pid: String, reason: String },
    Transcript {
        id: String,
        task: String,
        turns: Vec<Turn>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Pong {},
    /// The answer to a `keys` or `interrupt` that carried an id.
    Ack {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Something the client asked for failed outside any `call`.
    Error { message: String },
    #[serde(other)]
    Unknown,
}

/// One task as a client lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TaskRow {
    pub id: String,
    pub name: String,
    pub project: String,
    /// The default agent id ("claude").
    pub agent: String,
    /// Whether the host can show this task's conversation (`transcript`).
    /// False: a client opens its terminal instead, which every agent has.
    /// Absent from older hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// "working" | "waiting" | "done" | "idle" | "inactive" | "unknown".
    pub state: String,
    pub tabs: Vec<TabRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<Diff>,
    /// Creation time, RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// Shares the project's own checkout rather than a worktree.
    pub is_main_checkout: bool,
    /// When `state` last changed, epoch ms (the "2m" in a list).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<i64>,
    /// While working: what the agent says it is doing, one line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// While waiting: the question on the agent's screen, if it could be
    /// read. Absent means "look at the terminal".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<Question>,
    // How the host's own sidebar files and marks the task, so a client
    // draws it the same way. All optional: a host that has none of these
    // (termic-server) sends none, and a client that does not know them
    // ignores them.
    /// The task group it is in (a colour rail and a header on the host).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<RowGroup>,
    /// The folder its project sits in (projects sharing a name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_group: Option<RowGroup>,
    /// Pinned on the host: it stays listed whatever the filters say.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// The host's display order: its project's position, then the task's
    /// within the project. A client keeps them rather than re-sorting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    /// The task's pull or merge request, as the host last read it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<RowPr>,
    /// Its project's id: two projects can share a name (one here, one on a
    /// server), so a client groups by this when it is present.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub project_id: String,
    /// The server its project lives on, by name (a server project).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    /// Its project is folded shut in the host's sidebar.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub project_collapsed: bool,
    /// The host profile its project belongs to. Absent on a host with no
    /// profiles (and on termic-server): one unnamed profile, nothing to pick.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<RowProfile>,
}

/// A host profile (docs/profiles.md): `id` is its slug, `accent` its
/// `#rrggbb` colour, as the host's own profile strip draws it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RowProfile {
    pub id: String,
    pub name: String,
    pub accent: String,
}

/// A task group or a project folder. `color` is an accent KEY ("teal"),
/// never a literal colour: each client maps it to its own palette.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RowGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Folded shut in the host's sidebar, so a client can open in the same
    /// shape.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub collapsed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RowPr {
    pub number: u64,
    /// "open" | "draft" | "merged" | "closed", when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// "github" | "gitlab" | "azure": PR or MR in the label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// A property an agent put on a tab (`termic prop`, e.g. ticket=ABC-1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RowProp {
    pub key: String,
    pub value: String,
}

/// A question an agent is asking, read off its screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Question {
    /// Stable while the same question is on screen; changes when it does.
    /// `keys.question` carries it back.
    pub id: String,
    /// "command" | "edit" | "fetch" | "menu".
    pub kind: String,
    /// "Do you want to proceed?"
    pub title: String,
    /// What it is about: the command, the file, the URL. Shown in full.
    pub body: String,
    /// The agent's own options, in order, verbatim.
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct QuestionOption {
    pub label: String,
    /// What to type to choose it (base64), computed from the screen: the
    /// arrow keys from the highlighted option to this one, then Enter.
    pub keys: String,
    /// The option the agent has highlighted now (Enter picks it).
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TabRow {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub state: String,
    pub is_default: bool,
    /// "agent" | "shell" | "terminal" (a custom terminal) | "run" (the run
    /// script's tab). Absent from an older host, which sent agent tabs only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// A PTY is running in it, so `term_open` with this tab can attach.
    /// Absent from an older host: treat as openable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    /// `Some(false)`: this host cannot stream the tab to another machine (a
    /// plain shell or a custom terminal keeps no retained output and is not
    /// addressable). Absent: viewable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewable: Option<bool>,
    /// What the tab's agent labelled it with, in the order first set.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub props: Vec<RowProp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Diff {
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
}

/// One entry of an agent's transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Turn {
    /// "user" | "assistant" | "tool".
    pub role: String,
    pub text: String,
    /// For a tool call: the tool's name ("Bash", "Edit").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

impl ClientMsg {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    /// None only for bytes that are not JSON at all; an unknown `t` is
    /// `Unknown`, which the host ignores.
    pub fn parse(b: &[u8]) -> Option<ClientMsg> {
        serde_json::from_slice(b).ok()
    }
}

impl ServerMsg {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    pub fn parse(b: &[u8]) -> Option<ServerMsg> {
        serde_json::from_slice(b).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frozen shapes. Clients (the phone app among them) mirror exactly
    /// these; changing one breaks every phone in the field.
    #[test]
    fn client_shapes_are_frozen() {
        let cases: Vec<(ClientMsg, Value)> = vec![
            (
                ClientMsg::Hello { v: 1, name: "Phone".into(), kind: ClientKind::Phone, caps: vec![], app_version: None, grant: None, port: None },
                json!({"t":"hello","v":1,"name":"Phone","kind":"phone","caps":[]}),
            ),
            (ClientMsg::Call { id: "1".into(), req: json!({"cmd":"list"}), proto: None }, json!({"t":"call","id":"1","req":{"cmd":"list"}})),
            (ClientMsg::TermOpen { task: "x".into(), tab: None }, json!({"t":"term_open","task":"x"})),
            (ClientMsg::PtyOpen { pid: "p1".into(), cwd: "/r".into(), argv: vec![], env: vec![], cols: 80, rows: 24, seen: None }, json!({"t":"pty_open","pid":"p1","cwd":"/r","cols":80,"rows":24})),
            (ClientMsg::PtyKill { pid: "p1".into() }, json!({"t":"pty_kill","pid":"p1"})),
            (ClientMsg::TermClose {}, json!({"t":"term_close"})),
            (ClientMsg::TermInput { data: "DQ==".into() }, json!({"t":"term_input","data":"DQ=="})),
            (ClientMsg::TermSize { cols: 132, rows: 43 }, json!({"t":"term_size","cols":132,"rows":43})),
            (ClientMsg::Keys { task: "x".into(), tab: None, data: "Gw==".into(), id: None, question: None }, json!({"t":"keys","task":"x","data":"Gw=="})),
            (
                ClientMsg::Keys { task: "x".into(), tab: None, data: "DQ==".into(), id: Some("k1".into()), question: Some("q9".into()) },
                json!({"t":"keys","task":"x","data":"DQ==","id":"k1","question":"q9"}),
            ),
            (ClientMsg::Interrupt { task: "x".into(), tab: None, id: Some("i1".into()) }, json!({"t":"interrupt","task":"x","id":"i1"})),
            (ClientMsg::Resync {}, json!({"t":"resync"})),
            (ClientMsg::Transcript { id: "2".into(), task: "x".into() }, json!({"t":"transcript","id":"2","task":"x"})),
            (ClientMsg::Ping {}, json!({"t":"ping"})),
        ];
        for (msg, want) in cases {
            assert_eq!(serde_json::to_value(&msg).unwrap(), want);
            assert_eq!(serde_json::from_value::<ClientMsg>(want).unwrap(), msg);
        }
    }

    #[test]
    fn server_shapes_are_frozen() {
        let row = TaskRow { id: "1".into(), name: "fix".into(), project: "api".into(), agent: "claude".into(), state: "working".into(), ..Default::default() };
        let cases: Vec<(ServerMsg, Value)> = vec![
            (
                ServerMsg::Welcome { v: 1, id: "i".into(), name: "Mac".into(), version: "1.18.0".into(), kind: HostKind::Desktop, caps: vec!["tasks".into()], grant: Some("drive".into()), needs: None },
                json!({"t":"welcome","v":1,"id":"i","name":"Mac","version":"1.18.0","kind":"desktop","caps":["tasks"],"grant":"drive"}),
            ),
            (
                ServerMsg::Tasks { tasks: vec![row] },
                json!({"t":"tasks","tasks":[{"id":"1","name":"fix","project":"api","agent":"claude","state":"working","tabs":[],"is_main_checkout":false}]}),
            ),
            (ServerMsg::TermReset { task: "1".into(), tab: None, cols: 80, rows: 24, data: "".into() }, json!({"t":"term_reset","task":"1","cols":80,"rows":24,"data":""})),
            (ServerMsg::TermData { data: "eA==".into() }, json!({"t":"term_data","data":"eA=="})),
            (ServerMsg::TermResize { cols: 100, rows: 30 }, json!({"t":"term_resize","cols":100,"rows":30})),
            (ServerMsg::TermClosed { reason: "exited".into() }, json!({"t":"term_closed","reason":"exited"})),
            (ServerMsg::Pong {}, json!({"t":"pong"})),
            (ServerMsg::PtyData { pid: "p1".into(), data: "eA==".into(), at: None }, json!({"t":"pty_data","pid":"p1","data":"eA=="})),
            (ServerMsg::PtyExit { pid: "p1".into(), reason: "exited".into() }, json!({"t":"pty_exit","pid":"p1","reason":"exited"})),
            (ServerMsg::Ack { id: "k1".into(), ok: false, message: Some("stale".into()) }, json!({"t":"ack","id":"k1","ok":false,"message":"stale"})),
        ];
        for (msg, want) in cases {
            assert_eq!(serde_json::to_value(&msg).unwrap(), want);
            assert_eq!(serde_json::from_value::<ServerMsg>(want).unwrap(), msg);
        }
    }

    #[test]
    fn unknown_types_and_fields_are_ignored_not_errors() {
        assert_eq!(ClientMsg::parse(br#"{"t":"teleport","to":"mars"}"#), Some(ClientMsg::Unknown));
        assert_eq!(ServerMsg::parse(br#"{"t":"hologram"}"#), Some(ServerMsg::Unknown));
        let m = ClientMsg::parse(br#"{"t":"ping","future_field":1}"#).unwrap();
        assert_eq!(m, ClientMsg::Ping {});
        let row: TaskRow = serde_json::from_value(json!({"id":"1","state":"working","priority":"high"})).unwrap();
        assert_eq!(row.state, "working");
        assert!(ClientMsg::parse(b"not json").is_none());
    }

    #[test]
    fn a_hello_from_a_newer_client_still_parses() {
        let m = ClientMsg::parse(br#"{"t":"hello","v":7,"name":"P","kind":"watch","caps":["x"],"push_token":"abc"}"#).unwrap();
        match m {
            ClientMsg::Hello { v, kind, .. } => {
                assert_eq!(v, 7);
                assert_eq!(kind, ClientKind::Other);
            }
            _ => panic!("not a hello"),
        }
    }

    /// The sidebar fields: present when set, absent when not, and an old
    /// row (none of them) still reads.
    #[test]
    fn a_row_carries_its_group_folder_pin_order_pr_and_props() {
        let row = TaskRow {
            id: "1".into(),
            name: "fix".into(),
            project: "api".into(),
            agent: "claude".into(),
            state: "idle".into(),
            tabs: vec![TabRow { id: "t".into(), title: "claude".into(), agent: "claude".into(), state: "idle".into(), is_default: true, kind: "agent".into(), live: Some(true), viewable: None, props: vec![RowProp { key: "ticket".into(), value: "ABC-1".into() }] }],
            group: Some(RowGroup { id: "g".into(), name: "Auth".into(), color: Some("teal".into()), ..Default::default() }),
            project_group: Some(RowGroup { id: "Backend".into(), name: "Backend".into(), color: None, ..Default::default() }),
            pinned: true,
            project_order: Some(2),
            order: Some(0),
            pr: Some(RowPr { number: 42, state: Some("open".into()), title: Some("Fix login".into()), url: Some("https://github.com/acme/api/pull/42".into()), provider: Some("github".into()) }),
            ..Default::default()
        };
        let want = json!({
            "id":"1","name":"fix","project":"api","agent":"claude","state":"idle","is_main_checkout":false,
            "tabs":[{"id":"t","title":"claude","agent":"claude","state":"idle","is_default":true,"kind":"agent","live":true,"props":[{"key":"ticket","value":"ABC-1"}]}],
            "group":{"id":"g","name":"Auth","color":"teal"},
            "project_group":{"id":"Backend","name":"Backend"},
            "pinned":true,"project_order":2,"order":0,
            "pr":{"number":42,"state":"open","title":"Fix login","url":"https://github.com/acme/api/pull/42","provider":"github"}
        });
        assert_eq!(serde_json::to_value(&row).unwrap(), want);
        assert_eq!(serde_json::from_value::<TaskRow>(want).unwrap(), row);
        let old: TaskRow = serde_json::from_value(json!({"id":"1","name":"fix","project":"api","agent":"claude","state":"idle","tabs":[{"id":"t","title":"c","agent":"claude","state":"idle","is_default":true}],"is_main_checkout":false})).unwrap();
        assert_eq!((old.group, old.pinned, old.order, old.pr, old.tabs[0].props.len()), (None, false, None, None, 0));
        assert_eq!((old.tabs[0].kind.as_str(), old.tabs[0].live, old.tabs[0].viewable), ("", None, None), "an older host's tab: an agent, openable");
    }
}
