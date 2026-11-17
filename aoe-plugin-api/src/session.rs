//! DTOs for the `sessions.create`, `sessions.turn.send` and `sessions.message.send` RPCs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One MCP server a plugin attaches to a session (`mcp_servers` on
/// `sessions.create`, or the `servers` of `session.mcp.set`). Mirrors the
/// ecosystem `.mcp.json` entry shape the host already parses for every other
/// MCP layer: `transport` discriminates `stdio` (the default) from the `http`
/// and `sse` remote transports. The host converts this into its internal
/// project-MCP type, so a per-session server flows through the exact same
/// forwarding path as a global or project-local one — the point being that each
/// session can carry its OWN servers (e.g. its own agent-mcp url + bearer
/// token) and so authenticate to a remote MCP as its own identity. Requires the
/// high-severity `session.mcp` grant. `env` / `headers` are `BTreeMap` so the
/// wire encoding is order-independent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginMcpServer {
    /// Unique name within the session set; the key a same-named lower-layer
    /// server is shadowed under.
    pub name: String,
    /// `"stdio"` (default), `"http"`, or `"sse"`. Validated host-side.
    #[serde(default = "default_transport")]
    pub transport: String,
    /// stdio: the executable to launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// stdio: arguments passed to `command`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// stdio: environment for the launched process (values are secrets).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// http / sse: the endpoint URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// http / sse: request headers (values are secrets, e.g. a bearer token).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

fn default_transport() -> String {
    "stdio".to_string()
}

/// Parameters of `sessions.create`. Requires the `session.create` grant;
/// additionally `session.prompt` when `initial_turn` is present and
/// `session.unattended` when the host classifies `mode_id` as unattended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionsCreateRequest {
    /// Agent to run, an id from `acp.capabilities.get`.
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_project_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sandbox: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Approval mode id. Omitted means the adapter default (interactive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_turn: Option<InitialTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Per-session MCP servers for the created session, the highest-precedence
    /// MCP layer (a name here shadows the same name from every config-file
    /// layer). Requires the high-severity `session.mcp` grant; a non-empty
    /// value without it is refused. Empty (the default) keeps the pre-feature
    /// behavior. API v21.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<PluginMcpServer>,
}

/// The initial prompt of a created session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitialTurn {
    pub text: String,
}

/// Response of `sessions.create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionsCreateResponse {
    pub session_id: String,
    /// `false` when an existing session was returned by idempotency.
    pub created: bool,
}

/// Parameters of `session.mcp.set`: replace the per-session MCP set of a
/// session. Requires the `session.mcp` grant. Unlike `sessions.turn.send`, it
/// may target ANY session, not only one the calling plugin created — attaching
/// MCP to a dashboard-created session is the whole point (the ADR-0021 delivery
/// bridge depends on it). The host persists the set and restarts the worker so
/// the new servers forward on the next `session/load`. API v21.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMcpSetRequest {
    pub session_id: String,
    /// The complete replacement set; an empty vec clears the session's MCP
    /// servers.
    #[serde(default)]
    pub servers: Vec<PluginMcpServer>,
}

/// Parameters of `sessions.turn.send`. Requires the `session.prompt` grant;
/// the target must have been created by the calling plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnSendRequest {
    pub session_id: String,
    pub text: String,
}

/// Request of `sessions.message.send`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageSendRequest {
    pub session_id: String,
    pub message: String,
}

/// How the host handled a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDisposition {
    /// Typed into a terminal pane, or started as a new agent turn.
    Sent,
    /// Folded into the agent's running turn.
    Steered,
    /// Parked on the session's queue behind a running turn.
    Queued,
}

/// Response of `sessions.message.send`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSendResponse {
    pub disposition: MessageDisposition,
    /// A stopped or dormant session was woken to take the message.
    pub revived: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_request_wire_fixture_is_stable() {
        let request = SessionsCreateRequest {
            agent_id: "claude".into(),
            project_path: Some("/home/user/project".into()),
            extra_project_paths: Vec::new(),
            sandbox: false,
            model_id: Some("sonnet".into()),
            mode_id: Some("plan".into()),
            title: Some("nightly maintenance".into()),
            group: None,
            initial_turn: Some(InitialTurn {
                text: "Run the nightly task".into(),
            }),
            idempotency_key: Some("job-1:2026-07-16T03:00:00Z".into()),
            mcp_servers: Vec::new(),
        };
        let json = serde_json::to_value(&request).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "agent_id": "claude",
                "project_path": "/home/user/project",
                "model_id": "sonnet",
                "mode_id": "plan",
                "title": "nightly maintenance",
                "initial_turn": {"text": "Run the nightly task"},
                "idempotency_key": "job-1:2026-07-16T03:00:00Z"
            })
        );
        let round: SessionsCreateRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, request);
    }

    #[test]
    fn create_request_rejects_bypass_flags() {
        let err = serde_json::from_value::<SessionsCreateRequest>(serde_json::json!({
            "agent_id": "claude",
            "project_path": "/p",
            "allow_untrusted": true
        }))
        .expect_err("unknown fields must be rejected");
        assert!(err.to_string().contains("allow_untrusted"));
    }

    #[test]
    fn message_send_wire_shapes_are_stable() {
        let response = MessageSendResponse {
            disposition: MessageDisposition::Steered,
            revived: true,
        };
        assert_eq!(
            serde_json::to_value(&response).expect("serialize"),
            serde_json::json!({"disposition": "steered", "revived": true})
        );
        let err = serde_json::from_value::<MessageSendRequest>(serde_json::json!({
            "session_id": "s",
            "message": "hi",
            "text": "x"
        }))
        .expect_err("unknown fields must be rejected");
        assert!(err.to_string().contains("text"));
    }

    #[test]
    fn scratch_request_omits_project_path() {
        let request = SessionsCreateRequest {
            agent_id: "claude".into(),
            project_path: None,
            extra_project_paths: Vec::new(),
            sandbox: false,
            model_id: None,
            mode_id: None,
            title: None,
            group: None,
            initial_turn: None,
            idempotency_key: None,
            mcp_servers: Vec::new(),
        };
        let json = serde_json::to_value(&request).expect("serialize");
        assert!(json.get("project_path").is_none());
        assert!(json.get("extra_project_paths").is_none());
        let round: SessionsCreateRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, request);
    }

    #[test]
    fn sandbox_flag_serializes_only_when_set() {
        let mut request = SessionsCreateRequest {
            agent_id: "claude".into(),
            project_path: Some("/p".into()),
            extra_project_paths: Vec::new(),
            sandbox: false,
            model_id: None,
            mode_id: None,
            title: None,
            group: None,
            initial_turn: None,
            idempotency_key: None,
            mcp_servers: Vec::new(),
        };
        assert!(serde_json::to_value(&request)
            .expect("serialize")
            .get("sandbox")
            .is_none());
        request.sandbox = true;
        let json = serde_json::to_value(&request).expect("serialize");
        assert_eq!(json["sandbox"], serde_json::json!(true));
        let round: SessionsCreateRequest = serde_json::from_value(json).expect("deserialize");
        assert!(round.sandbox);
    }

    #[test]
    fn multi_repo_request_carries_extra_paths() {
        let request = SessionsCreateRequest {
            agent_id: "claude".into(),
            project_path: Some("/repos/app".into()),
            extra_project_paths: vec!["/repos/lib".into(), "/repos/proto".into()],
            sandbox: false,
            model_id: None,
            mode_id: None,
            title: None,
            group: None,
            initial_turn: None,
            idempotency_key: None,
            mcp_servers: Vec::new(),
        };
        let json = serde_json::to_value(&request).expect("serialize");
        assert_eq!(
            json["extra_project_paths"],
            serde_json::json!(["/repos/lib", "/repos/proto"])
        );
        let round: SessionsCreateRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, request);
    }

    #[test]
    fn plugin_mcp_server_wire_fixture_is_stable() {
        // The stdio default is implicit on the wire and the empty maps are
        // omitted, so a minimal stdio server stays compact.
        let stdio = PluginMcpServer {
            name: "fs".into(),
            transport: "stdio".into(),
            command: Some("mcp-fs".into()),
            args: vec!["--root".into(), ".".into()],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
        };
        let json = serde_json::to_value(&stdio).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "name": "fs",
                "transport": "stdio",
                "command": "mcp-fs",
                "args": ["--root", "."]
            })
        );
        let round: PluginMcpServer = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, stdio);

        // An http server carries its url + a header secret; transport is
        // explicit here since it is not the stdio default.
        let http = PluginMcpServer {
            name: "agent-mcp".into(),
            transport: "http".into(),
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            url: Some("https://agent-mcp.example/mcp".into()),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer tok".to_string())]),
        };
        let json = serde_json::to_value(&http).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "name": "agent-mcp",
                "transport": "http",
                "url": "https://agent-mcp.example/mcp",
                "headers": {"Authorization": "Bearer tok"}
            })
        );
        let round: PluginMcpServer = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, http);
    }

    #[test]
    fn plugin_mcp_server_transport_defaults_to_stdio() {
        // `transport` omitted -> stdio, matching the ecosystem `.mcp.json`
        // default, so the common stdio case needs no discriminator.
        let server: PluginMcpServer =
            serde_json::from_value(serde_json::json!({ "name": "fs", "command": "mcp-fs" }))
                .expect("deserialize");
        assert_eq!(server.transport, "stdio");
    }

    #[test]
    fn plugin_mcp_server_rejects_unknown_fields() {
        let err = serde_json::from_value::<PluginMcpServer>(serde_json::json!({
            "name": "fs",
            "command": "mcp-fs",
            "smuggled": true
        }))
        .expect_err("unknown fields must be rejected");
        assert!(err.to_string().contains("smuggled"));
    }

    #[test]
    fn create_request_carries_mcp_servers() {
        let request = SessionsCreateRequest {
            agent_id: "claude".into(),
            project_path: Some("/p".into()),
            extra_project_paths: Vec::new(),
            sandbox: false,
            model_id: None,
            mode_id: None,
            title: None,
            group: None,
            initial_turn: None,
            idempotency_key: None,
            mcp_servers: vec![PluginMcpServer {
                name: "agent-mcp".into(),
                transport: "http".into(),
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                url: Some("https://agent-mcp.example/mcp".into()),
                headers: BTreeMap::from([("Authorization".to_string(), "Bearer tok".to_string())]),
            }],
        };
        let json = serde_json::to_value(&request).expect("serialize");
        assert_eq!(json["mcp_servers"][0]["name"], "agent-mcp");
        let round: SessionsCreateRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(round, request);
    }
}
