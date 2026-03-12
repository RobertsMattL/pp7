# Scrolling Bug Fix - Header Pushed Off Screen

## Problem

When there was a lot of text output, the header UI elements were getting pushed off the top of the screen. The panels were growing taller than their allocated space, causing the entire UI to exceed the terminal height.

## Root Causes

### 1. Incorrect Height Calculation Logic

The original logic had a flaw in how it calculated and enforced content height:

```go
// BEFORE - BUGGY:
contentHeight := height - 2  // for title + separator
contentHeight -= len(pinnedLines)  // reduce for pinned lines

// Add pinned lines to displayLines
displayLines = append(displayLines, pinnedLines...)

// Add scrolling content (up to contentHeight)
for i, l := range lines {
    if i >= contentHeight {
        break
    }
    displayLines = append(displayLines, l)
}

// Result: displayLines = pinnedLines + contentHeight lines
// Total = len(pinnedLines) + contentHeight
// This EXCEEDS totalHeight!
```

**The bug:** We subtracted `len(pinnedLines)` from `contentHeight`, but then added both `pinnedLines` AND `contentHeight` lines to `displayLines`. This meant the total exceeded the allocated space.

### 2. Panel Height Budget Underestimated

The UI overhead calculation was too conservative:

```go
// BEFORE:
panelHeight := m.height - 7  // Not enough!
```

Actual UI elements:
- Header: 1 line + newline = 2 lines
- Status bar: 1 line + newline = 2 lines
- Agent selector: 1 line + newline = 2 lines
- Input: 1 line + newline = 2 lines
- **Total: 8 lines**, not 7

### 3. Missing Hard Height Constraint

The panel rendering removed `.Height()` (to fix expansion bug) but didn't replace it with a proper constraint:

```go
// BEFORE:
return style.Width(width).Render(content)
// No height constraint at all!
```

## Solution

### 1. Fixed Height Calculation Logic

Rewrote the logic to properly calculate and enforce bounds:

```go
// AFTER - FIXED:
totalContentHeight := height - 2  // for title + separator

// Build pinned lines
var pinnedLines []string
if ap.currentPrompt != "" {
    pinnedLines = append(pinnedLines, ap.currentPrompt)
    pinnedLines = append(pinnedLines, "")  // blank separator
}

// Calculate REMAINING space
scrollingHeight := totalContentHeight - len(pinnedLines)
if scrollingHeight < 0 {
    scrollingHeight = 0
}

// Trim scrolling lines to available space
if len(lines) > scrollingHeight {
    lines = lines[len(lines)-scrollingHeight:]
}

// Build displayLines: pinned + scrolling (up to scrollingHeight)
displayLines = append(displayLines, pinnedLines...)
for i := 0; i < len(lines) && i < scrollingHeight; i++ {
    displayLines = append(displayLines, lines[i])
}

// Pad to EXACT totalContentHeight
for len(displayLines) < totalContentHeight {
    displayLines = append(displayLines, "")
}

// Final safety check
if len(displayLines) > totalContentHeight {
    displayLines = displayLines[:totalContentHeight]
}

// Result: displayLines is EXACTLY totalContentHeight
```

**Key improvements:**
- Calculate `scrollingHeight` as `totalContentHeight - len(pinnedLines)`
- Only add `scrollingHeight` worth of scrolling content
- Ensures `displayLines = pinnedLines + scrollingContent` where total = `totalContentHeight`
- Multiple safety checks prevent overflow

### 2. Corrected Panel Height Budget

```go
// AFTER - FIXED:
// Reserve height for:
// - header: 1 line + newline: 2 lines
// - status bar: 1 line + newline: 2 lines
// - agent selector: 1 line + newline: 2 lines
// - input: 1 line + newline: 2 lines
// Total overhead: 8 lines
panelHeight := m.height - 8
if panelHeight < 5 {
    panelHeight = 5
}
```

### 3. Added MaxHeight Constraint

```go
// AFTER - FIXED:
// Use MaxHeight to enforce a hard limit without expansion
// This prevents panels from growing beyond allocated space
return style.Width(width).MaxHeight(height).Render(content)
```

**Why MaxHeight works better:**
- `.Height(height)` sets a *minimum* height (can cause expansion)
- `.MaxHeight(height)` sets a *maximum* height (prevents overflow)
- Combined with exact content sizing, provides double protection

## Verification

### Height Budget Math

For a terminal with `height = 24`:

```
Panel height calculation:
24 - 8 = 16 lines for panels

Panel content breakdown:
16 - 2 (title + separator) = 14 lines for content

With pinned prompt (2 lines):
14 - 2 = 12 lines for scrolling content

Final panel structure:
- Title: 1 line
- Separator: 1 line
- Pinned prompt: 1 line
- Blank: 1 line
- Scrolling: 12 lines
Total: 16 lines ✓

Total UI:
- Header: 2 lines
- Panels: 16 lines
- Status: 2 lines
- Selector: 2 lines
- Input: 2 lines
Total: 24 lines ✓
```

Perfect fit!

## Testing

✅ All unit tests pass
✅ Build successful
✅ Height constraints enforced at multiple levels

### Manual Test

1. Start system (server, agent, boss)
2. Send multiple long prompts
3. Verify:
   - Header stays at top
   - Panels don't overflow
   - Content scrolls within panels
   - Terminal resizing works correctly

## Files Modified

- `internal/boss/tui.go`
  - Line 664-677: Fixed panel height calculation (now 8 lines overhead)
  - Line 687-760: Rewrote renderOnePanel height logic
  - Line 772: Added MaxHeight constraint

## Prevention

To prevent similar issues:

1. **Always calculate exact heights** - Account for every UI element
2. **Use clear variable names** - `totalContentHeight`, `scrollingHeight` are self-documenting
3. **Add safety checks** - Multiple bounds checks at different stages
4. **Use MaxHeight for limits** - Not `.Height()` which can expand
5. **Test with extreme cases** - Very long output, small terminals, etc.

## Summary

The scrolling bug was caused by:
1. Incorrect height arithmetic (adding more lines than allocated)
2. Underestimated UI overhead (7 instead of 8 lines)
3. Missing height constraint (no MaxHeight)

The fix:
1. Rewrote height calculation to be explicit and correct
2. Updated overhead calculation to account for all UI elements
3. Added MaxHeight constraint for hard limit

The UI now properly respects terminal height at all times.
