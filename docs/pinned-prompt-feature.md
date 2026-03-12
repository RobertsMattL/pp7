# Pinned Prompt Feature

## Overview

The **pinned prompt** feature keeps your current user prompt visible at the top of the agent panel while the task executes. This helps you remember what you asked while watching Claude's response unfold.

## How It Works

### Visual Layout

```
┌─ agent1 [BUSY] ─────────────┐
│ [user] explain linked lists │ ← PINNED at top
│                              │
│ [system] Claude session...  │ ← Scrolling content starts here
│ A linked list is a data▌    │ ← Animation happening
│ ...                          │
│                              │
└──────────────────────────────┘
```

### Behavior

1. **User sends prompt** → Prompt pinned at top with `[user]` tag
2. **Task executes** → Prompt stays visible while content scrolls below
3. **Task completes** → Prompt moves to output history (unpinned)
4. **Next prompt** → New prompt replaces old one at top

## Implementation Details

### Architecture

**State Management** (`agentPanel` struct)
```go
type agentPanel struct {
    currentPrompt string // Current pinned prompt at top
    output []string      // Scrolling output history
    // ... animation fields ...
}
```

**Key Functions:**

1. **Setting the prompt** (`tui.go:149-168`)
   - When user presses Enter
   - Sets `currentPrompt` with `[user]` tag
   - Sends command to agent

2. **Rendering** (`tui.go:673-750`)
   - Reserves space at top for `currentPrompt`
   - Reduces `contentHeight` by 2 lines (prompt + separator)
   - Displays pinned lines, then scrolling content below

3. **Clearing on completion** (`tui.go:248-269`)
   - When `IsFinal` is true
   - Moves `currentPrompt` to `output` history
   - Clears `currentPrompt` field
   - Adds `[done]` marker

### Space Management

The rendering logic dynamically adjusts space:

```
Total panel height: height
├─ Title: 1 line
├─ Separator: 1 line
├─ Pinned prompt: 1 line (if active)
├─ Blank separator: 1 line (if prompt active)
└─ Scrolling content: remaining lines
```

**Example with prompt:**
- Panel height: 20 lines
- Title + separator: 2 lines
- Pinned prompt + blank: 2 lines
- Scrolling content: 16 lines

**Example without prompt:**
- Panel height: 20 lines
- Title + separator: 2 lines
- Scrolling content: 18 lines

## User Experience Benefits

### Problem Solved

**Before:** Long responses would scroll the prompt off screen, making users forget what they asked.

**After:** The prompt stays visible at the top, providing constant context.

### Use Cases

1. **Long explanations** - Remember what you asked while reading the response
2. **Tool-heavy tasks** - Track your request while Claude executes multiple tools
3. **Multi-step operations** - See original intent while watching progress
4. **Debugging** - Know what you requested while examining output

## Code Flow

```
User types and presses Enter
    ↓
m.agents[sel].currentPrompt = "[user] <prompt>"
    ↓
renderOnePanel() called repeatedly
    ↓
Checks if currentPrompt != ""
    ↓
YES → Reserve 2 lines at top
    ↓
Display: pinnedLines + scrollingContent
    ↓
Task completes (IsFinal = true)
    ↓
Move currentPrompt to output[]
    ↓
Clear currentPrompt
    ↓
Next render shows full scrolling history
```

## Testing

### Manual Test

1. Start the system:
   ```bash
   ./bin/parallelagents-server  # Terminal 1
   ./bin/parallelagents-agent -name agent1  # Terminal 2
   ./bin/parallelagents-boss  # Terminal 3
   ```

2. Send a prompt that generates a long response:
   ```
   explain how hash tables work in detail
   ```

3. Observe:
   - `[user] explain how hash tables work in detail` stays at top
   - Response content scrolls below
   - Animation happens in scrolling area
   - On completion, prompt moves to history

### Edge Cases Handled

✅ **Empty prompt** - Prompt must be non-empty to pin
✅ **Small panels** - Minimum 1 line for scrolling content
✅ **Multiple commands** - New prompt replaces old one
✅ **Window resize** - Space recalculated on each render
✅ **Task failure** - Prompt still cleared on IsFinal

## Performance

- **Minimal overhead** - Single string field per agent
- **No extra allocations** - Reuses existing rendering logic
- **Consistent height** - Space management prevents overflow

## Future Enhancements

Potential improvements:

1. **Prompt history** - Show last N prompts in a collapsed view
2. **Prompt editing** - Click to edit and resubmit
3. **Multi-line prompts** - Better handling of very long prompts
4. **Sticky/unsticky toggle** - User controls pinning behavior
5. **Color coding** - Different style for pinned vs scrolling content

## Files Modified

- `internal/boss/tui.go`
  - Line 48: Added `currentPrompt` field to `agentPanel`
  - Line 155: Set `currentPrompt` when command sent
  - Line 253-256: Clear `currentPrompt` on task completion
  - Line 686-694: Reserve space for pinned prompt
  - Line 718-724: Render pinned lines at top

## Summary

The pinned prompt feature enhances UX by keeping the user's original question visible throughout task execution. It's simple, efficient, and integrates seamlessly with the existing typewriter animation and scrolling logic.
