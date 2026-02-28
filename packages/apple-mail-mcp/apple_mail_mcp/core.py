"""Core helpers: AppleScript execution, escaping, parsing, and preference injection."""

import os
import subprocess
from typing import List, Dict, Any

from apple_mail_mcp.server import USER_PREFERENCES

# --- Security: path validation ---

ALLOWED_SAVE_DIRS = [
    os.path.expanduser("~/Desktop"),
    os.path.expanduser("~/Downloads"),
    os.path.expanduser("~/Documents"),
]

# Allow overriding via env var (comma-separated)
_extra = os.environ.get("APPLE_MAIL_ALLOWED_SAVE_DIRS", "")
if _extra:
    ALLOWED_SAVE_DIRS.extend(os.path.expanduser(d.strip()) for d in _extra.split(",") if d.strip())


def validate_save_path(path: str) -> str:
    """Validate that a save path is within allowed directories. Returns the resolved path or raises ValueError."""
    expanded = os.path.expanduser(path)
    resolved = os.path.realpath(expanded)
    for allowed in ALLOWED_SAVE_DIRS:
        if resolved.startswith(os.path.realpath(allowed)):
            return resolved
    raise ValueError(
        f"Save path '{path}' is outside allowed directories. "
        f"Allowed: {', '.join(ALLOWED_SAVE_DIRS)}"
    )


# --- Security: recipient validation ---

_allowed_domains_raw = os.environ.get("APPLE_MAIL_ALLOWED_RECIPIENT_DOMAINS", "")
ALLOWED_RECIPIENT_DOMAINS = [d.strip().lower() for d in _allowed_domains_raw.split(",") if d.strip()] if _allowed_domains_raw else []


def validate_recipients(*address_lists: str | None) -> str | None:
    """Validate that all email recipients are in allowed domains. Returns error string or None."""
    if not ALLOWED_RECIPIENT_DOMAINS:
        return None  # No allowlist configured — allow all (backwards compatible)
    for addr_list in address_lists:
        if not addr_list:
            continue
        for addr in addr_list.split(","):
            addr = addr.strip()
            if not addr:
                continue
            domain = addr.rsplit("@", 1)[-1].lower() if "@" in addr else ""
            if domain not in ALLOWED_RECIPIENT_DOMAINS:
                return f"Recipient '{addr}' not in allowed domains: {', '.join(ALLOWED_RECIPIENT_DOMAINS)}"
    return None


def inject_preferences(func):
    """Decorator that appends user preferences to tool docstrings"""
    if USER_PREFERENCES:
        if func.__doc__:
            func.__doc__ = func.__doc__.rstrip() + f"\n\nUser Preferences: {USER_PREFERENCES}"
        else:
            func.__doc__ = f"User Preferences: {USER_PREFERENCES}"
    return func


def escape_applescript(value: str) -> str:
    """Escape a string for safe injection into AppleScript double-quoted strings.

    Handles backslashes first, then double quotes, to prevent injection.
    """
    return value.replace('\\', '\\\\').replace('"', '\\"')


def run_applescript(script: str) -> str:
    """Execute AppleScript via stdin pipe for reliable multi-line handling"""
    try:
        result = subprocess.run(
            ['osascript', '-'],
            input=script,
            capture_output=True,
            text=True,
            timeout=120
        )
        if result.returncode != 0 and result.stderr.strip():
            raise Exception(f"AppleScript error: {result.stderr.strip()}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise Exception("AppleScript execution timed out")
    except Exception as e:
        raise Exception(f"AppleScript execution failed: {str(e)}")


def parse_email_list(output: str) -> List[Dict[str, Any]]:
    """Parse the structured email output from AppleScript"""
    emails = []
    lines = output.split('\n')

    current_email = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith('=') or line.startswith('━') or line.startswith('📧') or line.startswith('⚠'):
            continue

        if line.startswith('✉') or line.startswith('✓'):
            # New email entry
            if current_email:
                emails.append(current_email)

            is_read = line.startswith('✓')
            subject = line[2:].strip()  # Remove indicator
            current_email = {
                'subject': subject,
                'is_read': is_read
            }
        elif line.startswith('From:'):
            current_email['sender'] = line[5:].strip()
        elif line.startswith('Date:'):
            current_email['date'] = line[5:].strip()
        elif line.startswith('Preview:'):
            current_email['preview'] = line[8:].strip()
        elif line.startswith('TOTAL EMAILS'):
            # End of email list
            if current_email:
                emails.append(current_email)
            break

    if current_email and current_email not in emails:
        emails.append(current_email)

    return emails


# ---------------------------------------------------------------------------
# Shared AppleScript template helpers
# ---------------------------------------------------------------------------

LOWERCASE_HANDLER = '''
    on lowercase(str)
        set lowerStr to do shell script "echo " & quoted form of str & " | tr '[:upper:]' '[:lower:]'"
        return lowerStr
    end lowercase
'''


def inbox_mailbox_script(var_name: str = "inboxMailbox", account_var: str = "anAccount") -> str:
    """Return AppleScript snippet to get inbox mailbox with INBOX/Inbox fallback."""
    return f'''
                try
                    set {var_name} to mailbox "INBOX" of {account_var}
                on error
                    set {var_name} to mailbox "Inbox" of {account_var}
                end try'''


def content_preview_script(max_length: int, output_var: str = "outputText") -> str:
    """Return AppleScript snippet to extract and truncate email content preview."""
    return f'''
                            try
                                set msgContent to content of aMessage
                                set AppleScript's text item delimiters to {{return, linefeed}}
                                set contentParts to text items of msgContent
                                set AppleScript's text item delimiters to " "
                                set cleanText to contentParts as string
                                set AppleScript's text item delimiters to ""

                                if length of cleanText > {max_length} then
                                    set contentPreview to text 1 thru {max_length} of cleanText & "..."
                                else
                                    set contentPreview to cleanText
                                end if

                                set {output_var} to {output_var} & "   Content: " & contentPreview & return
                            on error
                                set {output_var} to {output_var} & "   Content: [Not available]" & return
                            end try'''


def date_cutoff_script(days_back: int, var_name: str = "cutoffDate") -> str:
    """Return AppleScript snippet to set a date cutoff variable."""
    if days_back <= 0:
        return ""
    return f'''
            set {var_name} to (current date) - ({days_back} * days)'''


def skip_folders_condition(var_name: str = "mailboxName") -> str:
    """Return AppleScript condition to skip system folders (Trash, Junk, etc)."""
    from apple_mail_mcp.constants import SKIP_FOLDERS
    folder_list = ', '.join(f'"{f}"' for f in SKIP_FOLDERS)
    return f'{var_name} is not in {{{folder_list}}}'
