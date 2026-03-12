# Height Overflow Bug Fix

## Problem

The UI height was growing out of control, with panels expanding beyond their allocated space.

## Root Cause

The issue was caused by the combination of:

1. **Lipgloss Height constraint behavior**: The `.Height(height)` call in lipgloss sets a *minimum* height but doesn't enforce a maximum. When combined with borders and padding, it can cause expansion.

2. **Border interaction**: The border adds visual space around the content, and the `.Height()` call was conflicting with the actual content height calculation.

## Solution

### Changes Made (`internal/boss/tui.go`)

**1. Improved line limiting logic (lines 682-721)**
```go
// Build lines to display (make a copy to avoid modifying original)
lines := make([]string, len(ap.output))
copy(lines, ap.output)

// Add currently animating partial line (with cursor)
if ap.isAnimating && ap.currentLine != "" && ap.currentPos > 0 {
    partialLine := ap.currentLine[:ap.currentPos] + "▌"
    lines = append(lines, partialLine)
}

// Always trim to exact contentHeight before processing
if len(lines) > contentHeight {
    lines = lines[len(lines)-contentHeight:]
}

// ... processing ...

// Final safety check - ensure we never exceed contentHeight
if len(displayLines) > contentHeight {
    displayLines = displayLines[:contentHeight]
}
```

**Key improvements:**
- Make a copy of output slice to avoid side effects
- Trim to contentHeight before processing
- Add hard limit in loop to prevent overflow
- Final safety check after padding

**2. Removed problematic Height constraint (line 738-740)**
```go
// Before:
return style.Width(width).Height(height).Render(content)

// After:
// Don't use .Height() as it can cause expansion with borders
// Instead, rely on our careful content sizing above
return style.Width(width).Render(content)
```

**Why this works:**
- We carefully construct content to be exactly the right size
- Content = title (1 line) + separator (1 line) + displayLines (contentHeight lines)
- Total = contentHeight + 2 = height
- The border is rendered around this, naturally sizing the panel
- No conflict with lipgloss Height constraints

## Testing

✅ All unit tests pass
✅ Build successful
✅ Height now properly constrained

## Prevention

To prevent similar issues in the future:

1. **Never exceed contentHeight** - Always check array bounds before appending
2. **Avoid .Height() with borders** - Let content size naturally
3. **Use explicit copies** - Don't modify slices that might be referenced elsewhere
4. **Add safety checks** - Final bounds checking before rendering

## Files Modified

- `internal/boss/tui.go` - renderOnePanel() function (lines 682-740)

## Verification

To verify the fix is working:
1. Start the system (server, agent, boss)
2. Send multiple long prompts
3. Observe that panels stay within their allocated height
4. Resize terminal - panels should adjust properly

The UI should now maintain consistent height regardless of content volume.
