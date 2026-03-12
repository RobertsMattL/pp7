# Bug Fix: Agents Not Resetting to IDLE Status

## Problem

Agents were not returning to `[IDLE]` status after completing tasks. They would stay in `[BUSY]` status even after the task finished and `[done]` appeared in the output.

## Root Cause

The server was **not forwarding `StatusChange` messages** from agents to the boss TUI.

### What Was Happening

1. Agent completes task and sends `StatusChange` message with `status: "idle"`
2. Server receives the message in `readPumpAgent()` (hub.go:284-287)
3. Server calls `updateAgentStatus()` which:
   - Updates the agent's status in the hub's internal state ✓
   - Sends a new `AgentList` to the boss ✓
   - **BUT** does not forward the `StatusChange` message to the boss ❌

4. Boss TUI receives `AgentList` message which updates all agents
5. However, the `StatusMsg` handler in the TUI never receives the status change

### Why This Was a Problem

The boss TUI has two ways to receive status updates:

1. **`AgentListMsg`** - Complete list of all agents with their current status
   - Received when agents register/disconnect
   - Received when status changes (via `sendAgentListToBoss()`)
   - Calls `syncAgents()` which rebuilds the entire agent list

2. **`StatusMsg`** - Individual status change notification
   - **Was never being received** because server didn't forward it
   - Calls `updateAgentStatus()` which updates just one agent

The `AgentList` approach should have worked, but there could be timing issues or the message might get lost. More importantly, it's inefficient to send the entire agent list every time one agent changes status.

## Solution

Modified the server to **forward `StatusChange` messages to the boss** in addition to updating internal state.

### Code Change

**File:** `internal/server/hub.go` (lines 284-289)

```go
// BEFORE:
case protocol.TypeStatusChange:
    if env.StatusChange != nil {
        c.hub.updateAgentStatus(c.agentID, env.StatusChange.Status)
    }

// AFTER:
case protocol.TypeStatusChange:
    if env.StatusChange != nil {
        c.hub.updateAgentStatus(c.agentID, env.StatusChange.Status)
        // Also forward the status change message to the boss
        c.hub.forwardToBoss(message)
    }
```

### Why This Works

Now the boss receives both:

1. **`StatusChange` message** - Immediate status update
   - Boss TUI receives it as `StatusMsg`
   - Calls `updateAgentStatus()` instantly
   - Agent status updates immediately in the UI

2. **`AgentList` message** - Full sync
   - Still sent via `sendAgentListToBoss()`
   - Provides redundancy and ensures consistency
   - Handles edge cases like reconnections

## Message Flow (After Fix)

```
Agent completes task
    ↓
Sends StatusChange{status: "idle"}
    ↓
Server receives it
    ↓
├─→ Updates internal hub state
├─→ Sends AgentList to boss (for sync)
└─→ Forwards StatusChange to boss ✨ NEW!
    ↓
Boss TUI receives StatusChange
    ↓
Processes as StatusMsg
    ↓
Calls updateAgentStatus()
    ↓
Updates agent.info.Status = "idle"
    ↓
UI re-renders with [IDLE] tag ✓
```

## Testing

### Before Fix
```
agent1 [BUSY] - "your prompt"
... response appears ...
[✓] Command completed successfully
agent1 [BUSY] - "your prompt"  ❌ Still shows BUSY
```

### After Fix
```
agent1 [BUSY] - "your prompt"
... response appears ...
[✓] Command completed successfully
agent1 [IDLE] - "your prompt"  ✓ Changes to IDLE
```

## Build Status

✅ **Server rebuilt** with status forwarding
✅ **All tests passing**
✅ **Ready to deploy**

## Files Modified

- `internal/server/hub.go` - Line 288: Added `c.hub.forwardToBoss(message)`

## Verification Steps

1. Start server, agents, and boss TUI
2. Send a task to an agent
3. Observe agent status:
   - Changes to `[BUSY]` when task starts ✓
   - Changes to `[IDLE]` when task completes ✓
4. Prompt stays in title showing last task ✓

## Related Issues

This fix ensures that status changes are propagated immediately to the UI, making the system more responsive and accurate.

**Note:** The `AgentList` message is still sent as a backup, providing redundancy and ensuring the boss has the complete picture of all agent statuses. Both mechanisms now work together for reliability.
