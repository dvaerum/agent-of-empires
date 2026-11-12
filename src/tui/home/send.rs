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

/// One arrow-key press that moves the highlight of an opencode dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SelectionStep {
    Left,
    Right,
}

/// One character of a colour capture with the colours in force where it was drawn.
type Cell = (char, Option<Colour>, Option<Colour>);
type Colour = (u8, u8, u8, u8);

/// Split a `tmux capture-pane -e` line into characters with their foreground
/// and background colour. Only SGR escapes carry colour; other escapes are dropped.
fn colour_cells(line: &str) -> Vec<Cell> {
    let mut cells = Vec::new();
    let (mut fg, mut bg): (Option<Colour>, Option<Colour>) = (None, None);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            cells.push((c, fg, bg));
            continue;
        }
        if chars.peek() != Some(&'[') {
            continue;
        }
        chars.next();
        let mut params = String::new();
        let mut last = None;
        for c in chars.by_ref() {
            if c.is_ascii_alphabetic() {
                last = Some(c);
                break;
            }
            params.push(c);
        }
        if last != Some('m') {
            continue;
        }
        let codes: Vec<u32> = params.split(';').map(|p| p.parse().unwrap_or(0)).collect();
        let mut i = 0;
        while i < codes.len() {
            let code = codes[i];
            match code {
                0 => (fg, bg) = (None, None),
                39 => fg = None,
                49 => bg = None,
                38 | 48 if codes.get(i + 1) == Some(&2) && i + 4 < codes.len() => {
                    let v = Some((
                        2,
                        codes[i + 2] as u8,
                        codes[i + 3] as u8,
                        codes[i + 4] as u8,
                    ));
                    if code == 38 {
                        fg = v
                    } else {
                        bg = v
                    }
                    i += 4;
                }
                38 | 48 if codes.get(i + 1) == Some(&5) && i + 2 < codes.len() => {
                    let v = Some((5, codes[i + 2] as u8, 0, 0));
                    if code == 38 {
                        fg = v
                    } else {
                        bg = v
                    }
                    i += 2;
                }
                30..=37 | 90..=97 => fg = Some((1, code as u8, 0, 0)),
                40..=47 | 100..=107 => bg = Some((1, code as u8, 0, 0)),
                _ => {}
            }
            i += 1;
        }
    }
    cells
}

/// Which option (0-based) of how many the opencode permission dialog highlights.
///
/// opencode paints the selected option's background in the colour of the
/// dialog's left `┃` border. `None` when no such option row is on screen or the
/// border colour matches no option (never guess: a wrong guess approves).
pub(super) fn opencode_selected_option(ansi_pane: &str) -> Option<(usize, usize)> {
    const LABELS: [&str; 4] = ["Allow once", "Always allow", "Allow always", "Reject"];
    for line in ansi_pane.lines() {
        let cells = colour_cells(line);
        let text: Vec<char> = cells.iter().map(|c| c.0).collect();
        let find = |needle: &str| {
            let n: Vec<char> = needle.chars().collect();
            text.windows(n.len()).position(|w| w == n.as_slice())
        };
        if find("Allow once").is_none() || find("Reject").is_none() {
            continue;
        }
        let border = cells.iter().find(|c| c.0 == '\u{2503}')?.1?;
        let mut options: Vec<usize> = LABELS.iter().filter_map(|l| find(l)).collect();
        options.sort_unstable();
        let selected: Vec<usize> = options
            .iter()
            .enumerate()
            .filter(|(_, at)| cells[**at].2 == Some(border))
            .map(|(i, _)| i)
            .collect();
        return match selected.as_slice() {
            [one] => Some((*one, options.len())),
            _ => None,
        };
    }
    None
}

/// The presses that move the highlight from `from` to `target` among `count` wrapping options.
pub(super) fn keys_to_reach(from: usize, count: usize, target: usize) -> Vec<SelectionStep> {
    let right = (target + count - from) % count;
    let left = count - right;
    if right <= left {
        vec![SelectionStep::Right; right]
    } else {
        vec![SelectionStep::Left; left]
    }
}

/// What Escape leaves behind that Deny still has to dismiss, judged from the plain pane.
pub(super) fn deny_followup_tokens(
    pane: &str,
) -> Option<&'static [crate::agents::KeyToken<'static>]> {
    use crate::agents::KeyToken::Named;
    if pane.contains("ctrl+f minimize") {
        Some(&[Named("Escape")])
    } else if pane.contains("Reject permission")
        || pane.contains("Tell OpenCode what to do differently")
    {
        Some(&[Named("Enter")])
    } else {
        None
    }
}

/// What the permission flow needs from the agent pane; a trait so the keystroke
/// decisions are testable without tmux.
pub(super) trait DialogPane {
    fn capture_ansi(&self) -> anyhow::Result<String>;
    fn capture_plain(&self) -> anyhow::Result<String>;
    fn send(&self, tokens: &[crate::agents::KeyToken<'static>]) -> anyhow::Result<()>;
    fn settle(&self);
}

impl DialogPane for crate::tmux::Session {
    fn capture_ansi(&self) -> anyhow::Result<String> {
        self.capture_pane(40)
    }
    fn capture_plain(&self) -> anyhow::Result<String> {
        crate::tmux::Session::capture_plain(self, 40)
    }
    fn send(&self, tokens: &[crate::agents::KeyToken<'static>]) -> anyhow::Result<()> {
        self.send_key_tokens(tokens)
    }
    fn settle(&self) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Poll for the confirmation step a dialog may draw after the opening keys,
/// stopping as soon as the dialog is gone (nothing more to send).
fn send_allow_always_followup(
    pane: &impl DialogPane,
    response: &crate::agents::PermissionResponse,
) -> anyhow::Result<()> {
    if response.allow_always_followup.is_none() {
        return Ok(());
    }
    for _ in 0..10 {
        pane.settle();
        let text = pane.capture_plain()?;
        if let Some(tokens) = allow_always_followup_tokens(response, &text) {
            return pane.send(tokens);
        }
        if !text.contains('\u{25B3}') {
            return Ok(());
        }
    }
    Ok(())
}

/// Deliver one permission decision to the pane.
pub(super) fn send_permission_response(
    pane: &impl DialogPane,
    response: &crate::agents::PermissionResponse,
    choice: crate::tui::dialogs::PermissionResponseChoice,
    tokens: &'static [crate::agents::KeyToken<'static>],
) -> anyhow::Result<()> {
    use crate::tui::dialogs::PermissionResponseChoice::*;
    if response.pane_guided {
        match choice {
            Allow => move_highlight_to(pane, 0, 2)?,
            AllowAlways => move_highlight_to(pane, 1, 3)?,
            Deny => {}
        }
    }
    pane.send(tokens)?;
    match choice {
        AllowAlways => send_allow_always_followup(pane, response)?,
        Deny if response.pane_guided => dismiss_leftover_deny_stages(pane)?,
        _ => {}
    }
    Ok(())
}

/// Move the highlight to `target` and confirm by re-reading the pane that it
/// got there; sends nothing it cannot account for, so Enter never lands on an
/// option other than the one chosen.
///
/// `min_options` is how many options the dialog needs for `target` to be the
/// wanted one: Reject is last, so with two options index 1 is Reject, not Always allow.
fn move_highlight_to(
    pane: &impl DialogPane,
    target: usize,
    min_options: usize,
) -> anyhow::Result<()> {
    use crate::agents::KeyToken::Named;
    let unreadable = || anyhow::anyhow!("could not read which permission option is highlighted");
    let (from, count) = opencode_selected_option(&pane.capture_ansi()?).ok_or_else(unreadable)?;
    if count < min_options {
        anyhow::bail!(
            "the permission dialog has no option {} to select",
            target + 1
        );
    }
    let steps = keys_to_reach(from, count, target);
    if steps.is_empty() {
        return Ok(());
    }
    let tokens: Vec<_> = steps
        .iter()
        .map(|s| match s {
            SelectionStep::Left => Named("Left"),
            SelectionStep::Right => Named("Right"),
        })
        .collect();
    pane.send(&tokens)?;
    pane.settle();
    match opencode_selected_option(&pane.capture_ansi()?) {
        Some((at, _)) if at == target => Ok(()),
        _ => Err(unreadable()),
    }
}

/// After Escape: collapse an expanded dialog, or confirm a subagent's Reject
/// prompt. Bounded so a dialog that never settles cannot trap the caller.
fn dismiss_leftover_deny_stages(pane: &impl DialogPane) -> anyhow::Result<()> {
    for _ in 0..3 {
        pane.settle();
        match deny_followup_tokens(&pane.capture_plain()?) {
            Some(tokens) => pane.send(tokens)?,
            None => break,
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
        let sent = send_permission_response(&tmux_session, &response, choice, tokens);
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
            pane_guided: false,
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

    /// 2.x applies Always allow on the first Enter, 1.x asks to confirm. Once the
    /// highlight is on Always allow the opening key is a bare Enter (an extra one
    /// there would approve the next dialog unseen); the 1.x confirmation is added
    /// only when the pane draws it.
    #[test]
    fn opencode_allow_always_confirms_only_when_the_pane_asks() {
        let response = opencode_response();
        assert_eq!(response.allow_always, Some(&[KeyToken::Named("Enter")][..]));
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

    /// Escape rejects whichever option is highlighted, so Deny cannot land on an
    /// approving option the way arrow presses from an assumed start could.
    #[test]
    fn opencode_deny_is_escape_and_allow_reads_the_highlight_from_the_pane() {
        let response = opencode_response();
        assert_eq!(response.deny, &[KeyToken::Named("Escape")][..]);
        assert_eq!(response.allow, &[KeyToken::Named("Enter")][..]);
        assert!(response.pane_guided);
    }

    // Real 2.2.5 captures with colour escapes (`tmux capture-pane -p -e`).
    const THREE: [&str; 3] = [
        include_str!("../../../tests/fixtures/opencode/permission_dialog_ansi/v2_three_options_highlight_1.ans"),
        include_str!("../../../tests/fixtures/opencode/permission_dialog_ansi/v2_three_options_highlight_2.ans"),
        include_str!("../../../tests/fixtures/opencode/permission_dialog_ansi/v2_three_options_highlight_3.ans"),
    ];
    const TWO: [&str; 2] = [
        include_str!("../../../tests/fixtures/opencode/permission_dialog_ansi/v2_two_options_highlight_1.ans"),
        include_str!("../../../tests/fixtures/opencode/permission_dialog_ansi/v2_two_options_highlight_2.ans"),
    ];
    const EXPANDED_ANSI: &str = include_str!(
        "../../../tests/fixtures/opencode/permission_dialog_ansi/v2_three_options_expanded_highlight_3.ans"
    );
    const EXPANDED_PLAIN: &str = include_str!(
        "../../../tests/fixtures/opencode/permission_dialog_ansi/v2_three_options_expanded.txt"
    );
    const SUBAGENT_REJECT_STAGE: &str = include_str!(
        "../../../tests/fixtures/opencode/permission_dialog_ansi/v2_subagent_reject_stage.txt"
    );
    const PLAIN_DIALOG: &str = include_str!(
        "../../../tests/fixtures/opencode/waiting_permission/010_v2_shell_command.txt"
    );
    const MINI_DIALOG: &str =
        include_str!("../../../tests/fixtures/opencode/waiting_permission/002_mini.txt");

    #[test]
    fn selected_option_is_read_from_the_real_colour_captures() {
        for (i, pane) in THREE.iter().enumerate() {
            assert_eq!(opencode_selected_option(pane), Some((i, 3)), "three #{i}");
        }
        for (i, pane) in TWO.iter().enumerate() {
            assert_eq!(opencode_selected_option(pane), Some((i, 2)), "two #{i}");
        }
        assert_eq!(opencode_selected_option(EXPANDED_ANSI), Some((2, 3)));
    }

    #[test]
    fn selected_option_is_none_when_the_highlight_cannot_be_read() {
        // Plain text carries no colour, so no option can be told apart.
        assert_eq!(opencode_selected_option(PLAIN_DIALOG), None);
        // The mini footer has no left border glyph to take the colour from.
        assert_eq!(opencode_selected_option(MINI_DIALOG), None);
        assert_eq!(opencode_selected_option(SUBAGENT_REJECT_STAGE), None);
        assert_eq!(opencode_selected_option(OPENCODE_2X_TOOL_DONE), None);
        assert_eq!(opencode_selected_option(""), None);
        // A border colour that matches no option's background: never guess.
        let recoloured = THREE[0].replace("\x1b[38;2;250;178;131m", "\x1b[38;2;1;2;3m");
        assert_ne!(recoloured, THREE[0]);
        assert_eq!(opencode_selected_option(&recoloured), None);
    }

    #[test]
    fn keys_to_reach_always_ends_on_the_target_by_the_shorter_way() {
        for count in 2..=3usize {
            for from in 0..count {
                for target in 0..count {
                    let steps = keys_to_reach(from, count, target);
                    let mut at = from;
                    for step in &steps {
                        at = match step {
                            SelectionStep::Right => (at + 1) % count,
                            SelectionStep::Left => (at + count - 1) % count,
                        };
                    }
                    assert_eq!(at, target, "{from}->{target} of {count}: {steps:?}");
                    assert!(steps.len() <= count / 2, "{from}->{target} of {count}");
                    assert_eq!(steps.is_empty(), from == target);
                }
            }
        }
    }

    #[test]
    fn deny_followups_follow_what_escape_left_on_screen() {
        assert_eq!(
            deny_followup_tokens(EXPANDED_PLAIN),
            Some(&[KeyToken::Named("Escape")][..])
        );
        assert_eq!(
            deny_followup_tokens(SUBAGENT_REJECT_STAGE),
            Some(&[KeyToken::Named("Enter")][..])
        );
        assert_eq!(
            deny_followup_tokens("Tell OpenCode what to do differently"),
            Some(&[KeyToken::Named("Enter")][..])
        );
        assert_eq!(deny_followup_tokens(PLAIN_DIALOG), None);
        assert_eq!(deny_followup_tokens(OPENCODE_2X_TOOL_DONE), None);
        assert_eq!(deny_followup_tokens(""), None);
    }

    /// Stand-in for a pane running an opencode dialog: arrow keys rotate the
    /// highlight, other keys are recorded with the option highlighted at the time.
    struct FakePane {
        count: usize,
        highlight: std::cell::Cell<usize>,
        arrows_move: bool,
        /// Overrides the colour capture (e.g. no dialog on screen).
        ansi: Option<&'static str>,
        /// Successive plain captures; the last one repeats.
        plain: Vec<&'static str>,
        plain_reads: std::cell::Cell<usize>,
        sent: std::cell::RefCell<Vec<String>>,
        enter_on: std::cell::RefCell<Vec<usize>>,
    }

    impl FakePane {
        fn dialog(count: usize, highlight: usize) -> Self {
            Self {
                count,
                highlight: highlight.into(),
                arrows_move: true,
                ansi: None,
                plain: vec![""],
                plain_reads: 0.into(),
                sent: Default::default(),
                enter_on: Default::default(),
            }
        }
        fn sent(&self) -> Vec<String> {
            self.sent.borrow().clone()
        }
    }

    impl DialogPane for FakePane {
        fn capture_ansi(&self) -> anyhow::Result<String> {
            if let Some(fixed) = self.ansi {
                return Ok(fixed.to_string());
            }
            let panes: &[&str] = if self.count == 3 { &THREE } else { &TWO };
            Ok(panes[self.highlight.get()].to_string())
        }
        fn capture_plain(&self) -> anyhow::Result<String> {
            let i = self.plain_reads.get();
            self.plain_reads.set(i + 1);
            Ok(self.plain[i.min(self.plain.len() - 1)].to_string())
        }
        fn send(&self, tokens: &[KeyToken<'static>]) -> anyhow::Result<()> {
            for token in tokens {
                let name = match token {
                    KeyToken::Named(n) | KeyToken::Literal(n) => n.to_string(),
                };
                match name.as_str() {
                    "Right" if self.arrows_move => {
                        self.highlight.set((self.highlight.get() + 1) % self.count)
                    }
                    "Left" if self.arrows_move => self
                        .highlight
                        .set((self.highlight.get() + self.count - 1) % self.count),
                    "Enter" => self.enter_on.borrow_mut().push(self.highlight.get()),
                    _ => {}
                }
                self.sent.borrow_mut().push(name);
            }
            Ok(())
        }
        fn settle(&self) {}
    }

    fn respond(pane: &FakePane, choice: PermissionResponseChoice) -> anyhow::Result<()> {
        let response = opencode_response();
        let tokens = permission_response_tokens(&response, choice).expect("tokens");
        send_permission_response(pane, &response, choice, tokens)
    }

    #[test]
    fn allow_once_confirms_option_one_whatever_was_highlighted() {
        for count in [2, 3] {
            for start in 0..count {
                let pane = FakePane::dialog(count, start);
                respond(&pane, PermissionResponseChoice::Allow).expect("allowed");
                assert_eq!(
                    *pane.enter_on.borrow(),
                    vec![0],
                    "{count} options from {start}"
                );
            }
        }
    }

    #[test]
    fn allow_always_confirms_option_two_whatever_was_highlighted() {
        for start in 0..3 {
            let pane = FakePane::dialog(3, start);
            respond(&pane, PermissionResponseChoice::AllowAlways).expect("allowed always");
            assert_eq!(*pane.enter_on.borrow(), vec![1], "from {start}");
        }
    }

    #[test]
    fn allow_always_in_a_two_option_dialog_sends_nothing() {
        for start in 0..2 {
            let pane = FakePane::dialog(2, start);
            assert!(respond(&pane, PermissionResponseChoice::AllowAlways).is_err());
            assert!(pane.sent().is_empty(), "from {start}: {:?}", pane.sent());
        }
    }

    #[test]
    fn nothing_is_sent_when_no_dialog_can_be_read() {
        for choice in [
            PermissionResponseChoice::Allow,
            PermissionResponseChoice::AllowAlways,
        ] {
            let mut pane = FakePane::dialog(3, 0);
            pane.ansi = Some(OPENCODE_2X_TOOL_DONE);
            assert!(respond(&pane, choice).is_err());
            assert!(pane.sent().is_empty());
        }
    }

    #[test]
    fn enter_is_withheld_when_the_highlight_does_not_reach_the_target() {
        let mut pane = FakePane::dialog(3, 2);
        pane.arrows_move = false;
        assert!(respond(&pane, PermissionResponseChoice::Allow).is_err());
        assert!(pane.enter_on.borrow().is_empty());
    }

    #[test]
    fn allow_always_still_confirms_the_1x_step_when_the_pane_shows_it() {
        let mut pane = FakePane::dialog(3, 1);
        pane.plain = vec![OPENCODE_1X_ALWAYS_CONFIRM];
        respond(&pane, PermissionResponseChoice::AllowAlways).expect("allowed always");
        assert_eq!(pane.sent(), ["Enter", "Enter"]);
    }

    #[test]
    fn deny_escapes_once_when_nothing_else_is_left_on_screen() {
        let pane = FakePane::dialog(3, 1);
        respond(&pane, PermissionResponseChoice::Deny).expect("denied");
        assert_eq!(pane.sent(), ["Escape"]);
        assert!(pane.enter_on.borrow().is_empty());
    }

    #[test]
    fn deny_collapses_the_expanded_dialog_then_confirms_the_subagent_prompt() {
        let mut pane = FakePane::dialog(3, 2);
        pane.plain = vec![EXPANDED_PLAIN, SUBAGENT_REJECT_STAGE, PLAIN_DIALOG];
        respond(&pane, PermissionResponseChoice::Deny).expect("denied");
        assert_eq!(pane.sent(), ["Escape", "Escape", "Enter"]);
    }

    #[test]
    fn deny_confirms_the_subagent_prompt_without_expanding() {
        let mut pane = FakePane::dialog(3, 0);
        pane.plain = vec![SUBAGENT_REJECT_STAGE, PLAIN_DIALOG];
        respond(&pane, PermissionResponseChoice::Deny).expect("denied");
        assert_eq!(pane.sent(), ["Escape", "Enter"]);
    }

    #[test]
    fn deny_gives_up_after_three_follow_up_rounds() {
        let mut pane = FakePane::dialog(3, 0);
        pane.plain = vec![EXPANDED_PLAIN];
        respond(&pane, PermissionResponseChoice::Deny).expect("denied");
        assert_eq!(pane.sent(), ["Escape", "Escape", "Escape", "Escape"]);
    }

    #[test]
    fn agents_without_pane_guidance_get_their_keys_unchanged() {
        let response = PermissionResponse {
            allow: &[KeyToken::Literal("1")],
            allow_always: Some(&[KeyToken::Literal("2")]),
            allow_always_followup: None,
            deny: &[KeyToken::Literal("3")],
            pane_guided: false,
        };
        let pane = FakePane::dialog(3, 2);
        let tokens =
            permission_response_tokens(&response, PermissionResponseChoice::Deny).expect("tokens");
        send_permission_response(&pane, &response, PermissionResponseChoice::Deny, tokens)
            .expect("denied");
        assert_eq!(pane.sent(), ["3"]);
        assert_eq!(pane.plain_reads.get(), 0);
    }

    #[test]
    fn followup_is_absent_for_agents_that_declare_none() {
        let response = PermissionResponse {
            allow: &[],
            allow_always: None,
            allow_always_followup: None,
            deny: &[],
            pane_guided: false,
        };
        assert_eq!(
            allow_always_followup_tokens(&response, OPENCODE_1X_ALWAYS_CONFIRM),
            None
        );
    }
}
