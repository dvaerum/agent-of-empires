//! Sending a message or a permission response to the selected session.

use super::*;

/// Map a decision to its agent-defined keystroke sequence. Pure and
/// tmux-free so the choice-to-field mapping is unit-testable without a
/// real pane; `execute_permission_response` is the only caller.
pub(super) fn permission_response_tokens(
    response: &crate::agents::PermissionResponse,
    choice: crate::tui::dialogs::PermissionResponseChoice,
) -> Option<&'static [crate::agents::KeyToken<'static>]> {
    use crate::tui::dialogs::PermissionResponseChoice::*;
    match choice {
        Allow => Some(response.allow),
        AllowAlways => response.allow_always,
        Deny => Some(response.deny),
    }
}

/// The extra keys an Allow-always still needs, judged from the pane after the first sequence.
pub(super) fn allow_always_followup_tokens(
    response: &crate::agents::PermissionResponse,
    pane: &str,
) -> Option<&'static [crate::agents::KeyToken<'static>]> {
    let followup = response.allow_always_followup?;
    pane.contains(followup.when_pane_contains)
        .then_some(followup.tokens)
}

/// Poll for the confirmation step a dialog may draw after the opening keys,
/// stopping as soon as the dialog is gone (nothing more to send).
fn send_allow_always_followup(
    session: &crate::tmux::Session,
    response: &crate::agents::PermissionResponse,
) -> anyhow::Result<()> {
    if response.allow_always_followup.is_none() {
        return Ok(());
    }
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let pane = session.capture_plain(40)?;
        if let Some(tokens) = allow_always_followup_tokens(response, &pane) {
            return session.send_key_tokens(tokens);
        }
        if !pane.contains('\u{25B3}') {
            return Ok(());
        }
    }
    Ok(())
}

impl HomeView {
    pub fn set_instance_status(&mut self, id: &str, status: crate::session::Status) {
        self.mutate_instance(id, |inst| inst.status = status);
    }

    /// Mark a user interaction.
    ///
    /// The daemon stamps the canonical access time; gestures never save a
    /// local row/group mirror, including gestures that unsink a row.
    pub fn stamp_last_accessed(&mut self, id: &str) {
        // A session with a change in flight is stamped by that change's own
        // commit, so a second stamp is both redundant and refused by the
        // per-session command queue.
        if self.session_feed.has_pending(id) || self.session_feed.has_queued(id) {
            return;
        }
        if let Err(error) = self
            .session_feed
            .submit(id.to_owned(), crate::daemon::SessionMutation::Access)
        {
            tracing::warn!(target: "tui.home", session_id = %id, %error, "access request refused");
        }
    }

    /// Why the session's agent must not start or take input, if it is archived or trashed.
    pub(super) fn start_blocked(&self, session_id: &str) -> Option<crate::session::StartBlocked> {
        self.get_instance(session_id)?.ensure_startable().err()
    }

    /// Take the target the next message should be delivered to.
    pub(in crate::tui) fn take_send_target(&mut self) -> live_send::LiveSendTarget {
        std::mem::replace(
            &mut self.pending_send_target,
            live_send::LiveSendTarget::Agent,
        )
    }

    /// Deliver a queued message to a pane the daemon has confirmed ready.
    pub(in crate::tui) fn finish_send(
        &mut self,
        session_id: &str,
        tmux_name: &str,
        target: live_send::LiveSendTarget,
        message: &str,
        lease: &crate::tui::session_feed::NativeLease,
    ) {
        if !lease.is_valid() {
            return;
        }
        if !self.session_feed.native_interaction_available() {
            self.info_dialog = Some(InfoDialog::new(
                "Send Failed",
                "Native interaction is unavailable.",
            ));
            return;
        }
        // An archived or trashed agent takes no input, even with a live pane
        // (#4118). The runtime refuses the prepare that produced the receipt,
        // so this keeps the refusal on the delivery path itself; the row it
        // reads is the runtime's committed snapshot.
        if matches!(target, live_send::LiveSendTarget::Agent) {
            if let Some(blocked) = self.start_blocked(session_id) {
                self.info_dialog = Some(InfoDialog::new("Send Failed", &blocked.to_string()));
                return;
            }
        }
        let Some(inst) = self.get_instance(session_id).cloned() else {
            self.info_dialog = Some(InfoDialog::new(
                "Send Failed",
                "Session disappeared before the message could be sent.",
            ));
            return;
        };
        // The receipt named the pane the daemon confirmed, so nothing is
        // resolved locally and a stale name cannot be sent to.
        let tmux_session = crate::tmux::Session::from_name(tmux_name);
        // Agent gets a tool-specific Enter delay so paste-burst-aware
        // agents (e.g. Codex) don't swallow the final Enter. Shells in
        // the paired terminal panes don't need the delay.
        let delay = match &target {
            live_send::LiveSendTarget::Agent => crate::agents::send_keys_enter_delay(&inst.tool),
            live_send::LiveSendTarget::Terminal
            | live_send::LiveSendTarget::ContainerTerminal
            | live_send::LiveSendTarget::Tool(_) => 0,
        };
        // Rechecks the stored row and keeps a CLI or TUI archive out until the keys land.
        let _input_lock = match &target {
            live_send::LiveSendTarget::Agent => match inst.lock_for_input() {
                Ok(lock) => Some(lock),
                Err(e) => {
                    self.info_dialog = Some(InfoDialog::new("Send Failed", &e.to_string()));
                    return;
                }
            },
            _ => None,
        };
        if let Err(e) = tmux_session.send_keys_with_delay(message, delay) {
            self.info_dialog = Some(InfoDialog::new(
                "Send Failed",
                &format!("Failed to send message: {}", e),
            ));
            return;
        }
        self.stamp_last_accessed(session_id);
        if self.sort_order == crate::session::config::SortOrder::Attention {
            self.select_top_attention(None);
            self.selected_session = None;
        }
    }

    /// Send the tmux keystrokes for a permission-prompt decision straight
    /// to the selected session's agent pane. No pane-readiness wait like
    /// `execute_send_message` performs: this action only makes sense
    /// against an already-live pane showing a prompt, so there is nothing
    /// to revive.
    pub fn execute_permission_response(
        &mut self,
        session_id: &str,
        choice: crate::tui::dialogs::PermissionResponseChoice,
    ) {
        if !self.session_feed.native_interaction_available() {
            self.info_dialog = Some(InfoDialog::new(
                "Respond Failed",
                "Native interaction is unavailable.",
            ));
            return;
        }
        if let Some(blocked) = self.start_blocked(session_id) {
            self.info_dialog = Some(InfoDialog::new("Respond Failed", &blocked.to_string()));
            return;
        }
        let Some(inst) = self.get_instance(session_id) else {
            return;
        };
        if inst.is_structured() {
            return;
        }
        let Some(response) =
            crate::agents::get_agent(&inst.tool).and_then(|a| a.permission_response)
        else {
            return;
        };
        let Some(tokens) = permission_response_tokens(&response, choice) else {
            return;
        };
        let tmux_session = match crate::tmux::Session::new(&inst.id, &inst.title) {
            Ok(s) => s,
            Err(e) => {
                self.info_dialog = Some(InfoDialog::new(
                    "Respond Failed",
                    &format!("Failed to resolve session: {}", e),
                ));
                return;
            }
        };
        let _input_lock = match inst.lock_for_input() {
            Ok(lock) => lock,
            Err(error) => {
                self.info_dialog = Some(InfoDialog::new("Respond Failed", &error.to_string()));
                return;
            }
        };
        let sent = tmux_session.send_key_tokens(tokens).and_then(|()| {
            if choice == crate::tui::dialogs::PermissionResponseChoice::AllowAlways {
                send_allow_always_followup(&tmux_session, &response)
            } else {
                Ok(())
            }
        });
        if let Err(e) = sent {
            self.info_dialog = Some(InfoDialog::new(
                "Respond Failed",
                &format!("Failed to send response: {}", e),
            ));
        }
    }
}

#[cfg(test)]
mod permission_response_tokens_tests {
    use super::*;
    use crate::agents::{KeyToken, PermissionResponse};
    use crate::tui::dialogs::PermissionResponseChoice;

    #[test]
    fn maps_each_choice_to_its_own_field() {
        let response = PermissionResponse {
            allow: &[KeyToken::Literal("1")],
            allow_always: Some(&[KeyToken::Literal("2")]),
            allow_always_followup: None,
            deny: &[KeyToken::Literal("3")],
        };
        assert_eq!(
            permission_response_tokens(&response, PermissionResponseChoice::Allow),
            Some(response.allow)
        );
        assert_eq!(
            permission_response_tokens(&response, PermissionResponseChoice::AllowAlways),
            response.allow_always
        );
        assert_eq!(
            permission_response_tokens(&response, PermissionResponseChoice::Deny),
            Some(response.deny)
        );
        let without_always = PermissionResponse {
            allow_always: None,
            ..response
        };
        assert_eq!(
            permission_response_tokens(&without_always, PermissionResponseChoice::AllowAlways),
            None
        );
    }

    fn opencode_response() -> PermissionResponse {
        crate::agents::get_agent("opencode")
            .and_then(|a| a.permission_response)
            .expect("opencode declares permission keys")
    }

    const OPENCODE_1X_ALWAYS_CONFIRM: &str = include_str!(
        "../../../tests/fixtures/opencode/waiting_permission/021_v1_always_confirm.txt"
    );
    const OPENCODE_2X_ALWAYS_PREVIEW: &str = include_str!(
        "../../../tests/fixtures/opencode/waiting_permission/011_v2_always_allow_selected.txt"
    );
    const OPENCODE_2X_TOOL_DONE: &str =
        include_str!("../../../tests/fixtures/opencode/idle/012_v2_tool_done.txt");

    /// 2.x applies Always allow on the first Enter, 1.x asks to confirm. The
    /// opening keys must be the 2.x ones (an extra Enter there would approve
    /// the next dialog unseen); the 1.x confirmation is added only when the
    /// pane draws it.
    #[test]
    fn opencode_allow_always_confirms_only_when_the_pane_asks() {
        let response = opencode_response();
        assert_eq!(
            response.allow_always,
            Some(&[KeyToken::Named("Right"), KeyToken::Named("Enter")][..])
        );
        assert_eq!(
            allow_always_followup_tokens(&response, OPENCODE_1X_ALWAYS_CONFIRM),
            Some(&[KeyToken::Named("Enter")][..])
        );
        assert_eq!(
            allow_always_followup_tokens(&response, OPENCODE_2X_TOOL_DONE),
            None
        );
        // Still on the first dialog: the opening keys have not landed yet.
        assert_eq!(
            allow_always_followup_tokens(&response, OPENCODE_2X_ALWAYS_PREVIEW),
            None
        );
    }

    /// The selection starts on Allow once and wraps, so Left lands on Reject in
    /// every dialog shape (two or three options, 1.x or 2.x). Counting Right
    /// presses would land on Allow once in the two-option dialog.
    #[test]
    fn opencode_deny_reaches_reject_by_wrapping_left_from_the_first_option() {
        assert_eq!(
            opencode_response().deny,
            &[KeyToken::Named("Left"), KeyToken::Named("Enter")][..]
        );
    }

    #[test]
    fn followup_is_absent_for_agents_that_declare_none() {
        let response = PermissionResponse {
            allow: &[],
            allow_always: None,
            allow_always_followup: None,
            deny: &[],
        };
        assert_eq!(
            allow_always_followup_tokens(&response, OPENCODE_1X_ALWAYS_CONFIRM),
            None
        );
    }
}
