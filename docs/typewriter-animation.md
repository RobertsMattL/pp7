# Typewriter Animation Implementation

This document describes the typewriter animation feature that displays Claude's responses character-by-character in the ParallelAgents boss TUI.

## Overview

The typewriter animation creates a dynamic, real-time feel by revealing text progressively rather than showing complete responses instantly. This helps users:

- **Track progress**: See that Claude is actively responding
- **Read naturally**: Text appears at a readable pace
- **Distinguish content types**: Important tags/metadata appear instantly while prose animates

## Architecture

### Core Components

1. **Animation State** (`agentPanel` struct)
   ```go
   type agentPanel struct {
       info   protocol.AgentInfo
       output []string // fully displayed lines

       // Animation state
       animBuffer     []string // lines waiting to be animated
       currentLine    string   // line currently being animated
       currentPos     int      // position in current line
       isAnimating    bool     // animation in progress
       instantDisplay bool     // for instant display tags
   }
   ```

2. **Ticker System**
   - `typewriterTickMsg`: Message sent every `typewriterInterval` (15ms)
   - `typewriterTick()`: Creates the recurring ticker command
   - Runs continuously while any agent has content to animate

3. **Animation Engine** (`advanceAnimation()`)
   - Advances `currentPos` by `charsPerTick` (2 characters)
   - Moves completed lines from animation buffer to output
   - Returns `true` if more content needs animating

### Data Flow

```
Claude Stream → parseProgressLine() → shouldDisplayInstantly()
                                            ↓
                        ┌──────────────────────────────┐
                        │   Instant?                   │
                        └──────────────────────────────┘
                         ↓ YES                    ↓ NO
                    Add to output            Add to animBuffer
                    (immediate)              (animate later)
                                                  ↓
                                          typewriterTick()
                                                  ↓
                                          advanceAnimation()
                                                  ↓
                                        Move chars to display
                                                  ↓
                                          renderOnePanel()
                                           (show partial + ▌)
```

## Configuration

### Speed Settings

Located at the top of `internal/boss/tui.go`:

```go
const typewriterInterval = 15 * time.Millisecond  // Ticker frequency
const charsPerTick = 2                             // Characters per tick
```

**Effective speed**: ~133 characters per second (2 chars × 1000ms / 15ms)

### Instant vs. Animated

The `shouldDisplayInstantly()` function determines which content appears immediately:

**Instant Display:**
- `[user]` - User prompts
- `[tool]` - Tool invocations
- `[tool_result]` - Tool outputs
- `[system]` - System messages
- `[error]`, `[ERROR]` - Error messages
- `[✓]`, `[done]` - Status markers

**Animated:**
- Assistant text responses
- Explanations and prose from Claude
- Any text without a tag prefix

## Implementation Details

### Adding Content

When new progress arrives (`ProgressMsg`):

1. `appendProgress()` calls `parseProgressLine()` to extract display text
2. `shouldDisplayInstantly()` checks if text should animate
3. `addLineToAgent()` routes to either:
   - Direct output (instant)
   - Animation buffer (animated)

### Animation Loop

The `typewriterTickMsg` handler in `Update()`:

```go
case typewriterTickMsg:
    anyAnimating := false
    for i := range m.agents {
        if m.advanceAnimation(&m.agents[i]) {
            anyAnimating = true
        }
    }
    if anyAnimating {
        cmds = append(cmds, typewriterTick())
    }
```

- Advances all agents' animations
- Restarts ticker if any agent still has content
- Stops ticker when all animations complete

### Rendering Partial Lines

In `renderOnePanel()`:

```go
if ap.isAnimating && ap.currentLine != "" && ap.currentPos > 0 {
    partialLine := ap.currentLine[:ap.currentPos] + "▌"
    lines = append(lines, partialLine)
}
```

Shows the partially-revealed line with a cursor block (▌) at the end.

## Performance Considerations

### Efficiency

- **Minimal overhead**: Only active when content is animating
- **Batched updates**: Multiple characters per tick reduce update frequency
- **Selective animation**: Only prose animates; tags appear instantly
- **Automatic cleanup**: Ticker stops when no content to animate

### Resource Usage

- Ticker fires every 15ms during animation
- ~67 ticks per second
- Each tick processes all agents (typically 1-4)
- Negligible CPU impact on modern hardware

## Testing

### Manual Testing

1. Start the system (server, agent, boss)
2. Send a prompt: "explain what a linked list is"
3. Observe:
   - `[user]` appears instantly
   - `[system]` appears instantly
   - Explanation text types out with cursor
   - `[✓]` appears instantly when done

### Adjusting for Testing

To see animation more clearly:

```go
// Slower animation for demonstration
const typewriterInterval = 50 * time.Millisecond
const charsPerTick = 1
```

To disable for debugging:

```go
// Effectively instant
const typewriterInterval = 1 * time.Millisecond
const charsPerTick = 1000
```

## Future Enhancements

Potential improvements:

1. **Variable speed**: Slow down for punctuation, speed up for code blocks
2. **User control**: Toggle animation on/off with keyboard shortcut
3. **Smart pauses**: Brief pause at sentence boundaries
4. **Sound effects**: Optional typing sound (terminal bell)
5. **Cursor styles**: Different cursors for different content types
6. **Animation queue**: Prevent overwhelming users with too much simultaneous animation

## Troubleshooting

### Animation not visible

- Check that responses are long enough (short text completes in <1 second)
- Verify ticker is running (debug: add log in `typewriterTickMsg` handler)
- Ensure `isAnimating` flag is set (debug: log in `addLineToAgent()`)

### Animation too fast/slow

- Adjust `typewriterInterval` (smaller = faster)
- Adjust `charsPerTick` (larger = faster)
- Balance: Too fast defeats purpose, too slow frustrates users

### Multiple agents animating creates visual noise

This is expected behavior. Each agent animates independently. Consider:
- Limiting visible agents
- Pausing non-selected agents' animations
- Queuing animations rather than running in parallel

## Code References

| Function | Location | Purpose |
|----------|----------|---------|
| `typewriterTick()` | tui.go:97 | Creates ticker command |
| `advanceAnimation()` | tui.go:292 | Advances character position |
| `addLineToAgent()` | tui.go:268 | Routes to buffer or output |
| `shouldDisplayInstantly()` | tui.go:256 | Determines animation mode |
| `renderOnePanel()` | tui.go:663 | Shows partial line + cursor |

## Summary

The typewriter animation adds polish and visual feedback to the ParallelAgents TUI without sacrificing performance or clarity. By selectively animating only prose content while keeping tags instant, it strikes a balance between dynamism and usability.
