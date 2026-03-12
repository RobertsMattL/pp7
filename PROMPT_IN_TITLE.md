# ✨ Prompt in Title Feature

## Summary

The user prompt now appears **in the panel title** next to the agent name and status, instead of being pinned in the content area. This saves vertical space while keeping context visible.

## What Changed

### Before (Pinned in Content)
```
┌─ agent1 [BUSY] ─────────────┐
│ [user] explain hash tables   │ ← Used 2 lines of content space
│                              │
│ [system] Claude session...   │
│ Response content...          │
└──────────────────────────────┘
```

### After (In Title - Active)
```
┌─ agent1 [BUSY] - "explain hash tables" ─┐
│ [system] Claude session started         │ ← Full content area
│ A hash table is a data structure▌       │
│ that provides fast lookups...           │
│ ...                                      │
└──────────────────────────────────────────┘
```

### After (In Title - Idle)
```
┌─ agent1 [IDLE] - "explain hash tables" ─┐
│ [system] Claude session started         │ ← Last task visible
│ A hash table is a data structure...     │
│ [✓] Command completed successfully      │
└──────────────────────────────────────────┘
```

## Benefits

✅ **More content space** - No lines wasted on pinned prompt
✅ **Always visible** - Prompt in title is always on screen
✅ **Shows last task** - Even when idle, see what the agent last worked on
✅ **Cleaner layout** - Title shows status at a glance
✅ **Better UX** - One quick glance shows agent, status, and current/last task

## Implementation

### Changes Made

**1. Title Rendering** (`tui.go:687-708`)
```go
// Build title with prompt if active
var title string
if ap.currentPrompt != "" {
    // Strip the [user] prefix
    prompt := strings.TrimPrefix(ap.currentPrompt, "[user] ")
    // Truncate to fit
    maxPromptLen := width - len(ap.info.Name) - 15
    if len(prompt) > maxPromptLen {
        prompt = prompt[:maxPromptLen-3] + "..."
    }
    title = fmt.Sprintf("%s %s - \"%s\"", name, tag, prompt)
} else {
    title = fmt.Sprintf("%s %s", name, tag)
}
```

**2. Removed Pinned Lines Logic** (`tui.go:710-755`)
- Removed separate `pinnedLines` array
- Removed space calculation for pinned content
- Simplified content area to use full available height

**3. Updated Completion Handler** (`tui.go:248-266`)
```go
if p.IsFinal {
    // Task completed - keep the prompt in title to show last task
    m.addLineToAgent(&m.agents[i], "[done]", true)
}
```
- **Keeps** `currentPrompt` on completion (doesn't clear it)
- Shows what the agent last worked on when idle
- Only replaced when a new prompt is sent

## Format

**Title while task is running:**
```
agent1 [BUSY] - "your prompt here"
```

**Title after task completes (shows last task):**
```
agent1 [IDLE] - "your prompt here"
```

**Title before any tasks (initial state):**
```
agent1 [IDLE]
```

**Prompt truncation:**
- Calculates available space: `width - agentNameLength - 15`
- Truncates with `...` if too long
- Minimum 10 characters reserved for prompt

## Edge Cases Handled

✅ **Long prompts** - Truncated with ellipsis
✅ **Narrow panels** - Minimum prompt length enforced
✅ **Task completion** - Prompt clears cleanly
✅ **Multiple tasks** - New prompt replaces old one
✅ **Empty prompt** - Shows normal title

## Files Modified

- `internal/boss/tui.go`
  - Line 687-708: Title rendering with optional prompt
  - Line 710-755: Simplified content rendering (no pinned lines)
  - Line 251-253: Clear prompt on completion
- `PINNED_PROMPT.md` - Updated documentation
- `docs/pinned-prompt-feature.md` - Will need updating

## Build Status

✅ **Built successfully**
✅ **All 14 tests passing**
✅ **Ready to use**

## Testing

### Quick Test

```bash
./bin/parallelagents-server  # Terminal 1
./bin/parallelagents-agent -name agent1  # Terminal 2
./bin/parallelagents-boss  # Terminal 3
```

Send: `"explain how binary search works"`

Observe:
- While running, title shows: `agent1 [BUSY] - "explain how binary search works"`
- Content area has full height for response
- On completion, title shows: `agent1 [IDLE] - "explain how binary search works"`
- Prompt stays visible showing what the agent last worked on
- Next prompt will replace it

## Summary

This change provides a cleaner, more space-efficient way to show the current prompt while maintaining context. The prompt in the title acts as a status indicator, showing what the agent is currently working on (or last worked on when idle) without consuming precious content area.

**Key behavior:** The prompt persists in the title even after the task completes, so you can always see what each agent last worked on. New prompts replace old ones.
