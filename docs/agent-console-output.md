# Agent Console Output Format

This document describes what you'll see in the ParallelAgents console when using Claude.

## Typewriter Animation

The console features a **typewriter animation** that displays Claude's responses character-by-character, creating a dynamic, real-time feel.

### Animation Behavior

- **Animated content**: Assistant text responses appear character-by-character with a blinking cursor (▌)
- **Instant display**: System messages, tags, and tool invocations appear immediately
- **Animation speed**: Configurable via constants in `tui.go`:
  - `typewriterInterval` - milliseconds between updates (default: 15ms)
  - `charsPerTick` - characters added per update (default: 2)

### What Gets Animated

**Animated (character-by-character):**
- Assistant text responses
- Long explanations from Claude

**Instant (appears immediately):**
- `[user]` - Your prompts
- `[tool]` - Tool invocations
- `[tool_result]` - Tool outputs
- `[system]` - System messages
- `[error]`, `[ERROR]` - Error messages
- `[✓]`, `[done]` - Completion markers

## Output Format Examples

### Basic User Prompt and Response
```
[user] say hi
[system] Claude session started
[assistant] Processing...
Hi! I'm ready to help you with your software engineering tasks.
[✓] Command completed successfully
```

### Tool Usage Example
```
[user] list files in the current directory
[system] Claude session started
I'll list the files in the current directory for you.
[tool] Bash
  command: ls -la, description: List files in current directory
[tool_result] total 48
drwxrwxrwt  37 root  wheel   1184 Mar 11 16:50 .
drwxr-xr-x   6 root  wheel    192 Mar  3 11:09 ..
  ... (32 more lines)
The current directory contains:

**Regular files:**
- atak_builds.html (13KB)
- claude-tool-output.json (2KB)

**Directories:**
- Multiple sock-* directories
[✓] Command completed successfully
```

### Error Handling
```
[user] read a file that doesn't exist
[system] Claude session started
[tool] Read
  file_path: /nonexistent/file.txt
[tool_result] ERROR: file not found: /nonexistent/file.txt
I apologize, but the file doesn't exist. Would you like me to help you...
[✓] Command completed successfully
```

## Message Type Reference

| Tag | Description | When it appears |
|-----|-------------|-----------------|
| `[user]` | Your prompt to Claude | When you send a command |
| `[system]` | System initialization | Start of Claude session |
| `[assistant]` | Claude is processing | Beginning of response |
| `[tool]` | Tool invocation with parameters | When Claude uses a tool |
| `[tool_result]` | Output from tool execution | After tool runs |
| `[thinking]` | Claude's reasoning (if enabled) | During extended thinking |
| `[✓]` | Success marker | Command completed |
| `[error]` | Error in execution | When something fails |
| `[ERROR]` | Critical error | Fatal error occurred |

## Output Truncation

To keep the console readable:
- Tool input values longer than 60 chars are truncated with "..."
- Tool results longer than 150 chars show first 3 lines + line count
- Error messages longer than 200 chars are truncated

## Testing the Output

To test the enhanced console output:

1. Start the server:
   ```bash
   ./bin/parallelagents-server
   ```

2. Start an agent (in another terminal):
   ```bash
   ./bin/parallelagents-agent -name agent1
   ```

3. Start the boss TUI (in another terminal):
   ```bash
   ./bin/parallelagents-boss
   ```

4. Send test prompts:
   - Simple: "what is 2+2?"
   - With tools: "list files in current directory"
   - With error: "read /nonexistent/file.txt"

## Implementation Details

The console output parsing is handled in `internal/boss/tui.go` in the `parseProgressLine()` function, which processes Claude's `stream-json` output format.

Key message types processed:
- `system` - initialization messages
- `assistant` - Claude's responses and tool invocations
- `user` - tool results (confusingly named, but this is Claude's format)
- `result` - final completion status
- `error` - error messages
- `content_block_delta` - streaming text updates
- `content_block_start` - start of text/tool/thinking blocks
