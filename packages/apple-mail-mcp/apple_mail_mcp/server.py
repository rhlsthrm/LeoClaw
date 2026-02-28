"""FastMCP server instance and user preferences."""

import os
from mcp.server.fastmcp import FastMCP

# Initialize FastMCP server
mcp = FastMCP("Apple Mail MCP")

# Load and sanitize user preferences from environment
_raw_prefs = os.environ.get("USER_EMAIL_PREFERENCES", "")
_MAX_PREFS_LENGTH = 500
_BLOCKED_PATTERNS = ["always ", "never ", "bcc ", "forward ", "send to ", "ignore ", "override "]

def _sanitize_preferences(raw: str) -> str:
    if not raw:
        return ""
    if len(raw) > _MAX_PREFS_LENGTH:
        raw = raw[:_MAX_PREFS_LENGTH]
    lower = raw.lower()
    for pattern in _BLOCKED_PATTERNS:
        if pattern in lower:
            return ""  # Reject entirely if instructional pattern found
    return raw

USER_PREFERENCES = _sanitize_preferences(_raw_prefs)
