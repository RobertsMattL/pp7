# Testing Enhanced Agent Console Output

This document explains how to test the enhanced console output in ParallelAgents.

## What Was Enhanced

The agent console now displays significantly more information from Claude with a dynamic typewriter animation:

1. **Typewriter Animation**: Assistant text appears character-by-character with a cursor (▌)
   - Configurable speed: 15ms interval, 2 chars/tick
   - System messages and tags appear instantly for clarity
2. **Pinned Prompt**: Your prompt stays visible at the top of the pane during execution
   - Prevents losing context while watching long responses
   - Automatically moves to history when task completes
3. **User Prompts**: Shows `[user] <your prompt>` when you send commands
4. **System Messages**: Shows `[system] Claude session started` on initialization
5. **Tool Invocations**: Shows tool name AND input parameters
   - Example: `[tool] Bash` with `command: ls -la, description: List files`
6. **Tool Results**: Shows output from tool execution
   - Success: `[tool_result] <output>`
   - Errors: `[tool_result] ERROR: <message>`
7. **Completion Status**: Shows `[✓] Command completed successfully`
8. **Error Handling**: Shows `[ERROR]` for critical errors

## Files Modified

- `internal/boss/tui.go` - Enhanced `parseProgressLine()` and added typewriter animation
  - **Animation system** (lines 16-31): Constants and ticker messages
  - **Agent state** (lines 43-53): Animation buffer and tracking
  - **Animation logic** (lines 292-335): Character-by-character advancement
  - **User prompt display** (line 115): Shows `[user]` tag
  - **Tool parsing** (lines 260-304): Displays tool inputs
  - **Tool results** (lines 354-387): Shows tool outputs and errors
  - **Rendering** (lines 677-681): Shows partial line with cursor during animation
  - **Animation control**: Determines which content animates vs. appears instantly

## Running Tests

### Unit Tests

Run the comprehensive unit tests:

```bash
go test ./internal/boss -v
```

All 14 tests should pass, covering:
- User prompt display
- System initialization messages
- Assistant text responses
- Tool use with parameters
- Tool results (success and error)
- Long content truncation
- Edge cases (invalid JSON, empty input)

### Integration Testing

#### Option 1: Test with bash script

```bash
./test-tool-output.sh
```

This script runs Claude directly and shows the JSON structure.

#### Option 2: Manual testing with the full system

1. **Terminal 1 - Start the server:**
   ```bash
   ./bin/parallelagents-server
   ```

2. **Terminal 2 - Start an agent:**
   ```bash
   ./bin/parallelagents-agent -name agent1
   ```

3. **Terminal 3 - Start the boss TUI:**
   ```bash
   ./bin/parallelagents-boss
   ```

4. **Send test prompts in the boss TUI:**

   **Test 1: Simple prompt (no tools)**
   ```
   say hello
   ```

   Expected output:
   ```
   [user] say hello
   [system] Claude session started
   [assistant] Processing...
   Hello! How can I help you?
   [✓] Command completed successfully
   ```

   **Test 2: Tool usage**
   ```
   list files in current directory
   ```

   Expected output:
   ```
   [user] list files in current directory
   [system] Claude session started
   I'll list the files for you.
   [tool] Bash
     command: ls -la, description: List files in current directory
   [tool_result] total 48
   drwxr-xr-x  10 user  staff  320 Mar 11 ...
     ... (7 more lines)
   Here are the files in the current directory:
   - file1.txt
   - file2.txt
   [✓] Command completed successfully
   ```

   **Test 3: Tool with error**
   ```
   read /this/does/not/exist.txt
   ```

   Expected output:
   ```
   [user] read /this/does/not/exist.txt
   [system] Claude session started
   [tool] Read
     file_path: /this/does/not/exist.txt
   [tool_result] ERROR: file not found
   I apologize, but that file doesn't exist...
   [✓] Command completed successfully
   ```

## Output Truncation

To keep the console readable:

- **Tool inputs** longer than 60 characters are truncated
- **Tool results** longer than 150 characters show first 3 lines + line count
- **Error messages** longer than 200 characters are truncated

## Viewing Output Details

See `docs/agent-console-output.md` for complete documentation on:
- All message type tags
- Example outputs
- Implementation details

## Customizing Animation Speed

You can adjust the typewriter animation speed by modifying constants in `internal/boss/tui.go`:

```go
// Faster animation
const typewriterInterval = 10 * time.Millisecond  // default: 15ms
const charsPerTick = 3                             // default: 2

// Slower, more dramatic animation
const typewriterInterval = 30 * time.Millisecond
const charsPerTick = 1

// Instant (no animation)
const typewriterInterval = 1 * time.Millisecond
const charsPerTick = 100
```

After changing these values, rebuild:
```bash
make all
```

## Troubleshooting

### Not seeing tool details?

Make sure you've rebuilt the binaries after the changes:
```bash
make all
```

### Animation too fast or too slow?

Adjust `typewriterInterval` and `charsPerTick` constants in `internal/boss/tui.go` as shown above.

### Seeing raw JSON instead of formatted output?

Check that `parseProgressLine()` is being called in `appendProgress()` (line 243 in tui.go).

### Console output looks cut off?

This is expected for very long outputs. The truncation logic keeps the display manageable. Full output is still available in Claude's execution context.

### Animation not working?

Verify that:
1. The typewriter ticker is running (check Init() function)
2. Animation buffer is being populated (check addLineToAgent())
3. advanceAnimation() is being called on each tick

## Implementation Notes

The enhanced parser in `internal/boss/tui.go` handles these Claude stream-json message types:

| Type | Purpose |
|------|---------|
| `system` | Session initialization |
| `assistant` | Claude's responses and tool invocations |
| `user` | Tool results (confusingly named by Claude API) |
| `result` | Final completion status |
| `error` | Error messages |
| `content_block_delta` | Streaming text updates |
| `content_block_start` | Start of content blocks |
| `message_start` | Start of message processing |

The parser intelligently extracts:
- Text content from assistant messages
- Tool names and input parameters from tool_use blocks
- Results and errors from tool_result blocks
- Success/failure status from result messages
