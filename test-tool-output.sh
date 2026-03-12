#!/bin/bash
# Test script to verify Claude tool output parsing

echo "==================================="
echo "Testing Claude Tool Output Parsing"
echo "==================================="
echo ""

# Test 1: Simple response (no tools)
echo "Test 1: Simple prompt (no tools)"
echo "Prompt: 'say hello'"
echo "-----------------------------------"
claude -p "say hello" --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 | \
  jq -c 'select(.type != null) | {type, subtype, content: .message.content[0].text // .message.content[0].name // null}' | \
  head -5
echo ""

# Test 2: Tool usage
echo "Test 2: Tool usage"
echo "Prompt: 'what files are in /tmp'"
echo "-----------------------------------"
cd /tmp
claude -p "show me first 5 files in current directory" --output-format stream-json --verbose --dangerously-skip-permissions 2>&1 | \
  jq -c 'select(.type == "assistant" or .type == "user" or .type == "system") |
         {type,
          tool: (.message.content[0].name // null),
          tool_input: (.message.content[0].input // null),
          has_result: (if .message.content[0].type == "tool_result" then true else false end)
         }' | \
  head -10
echo ""

echo "==================================="
echo "Expected output in agent console:"
echo "==================================="
echo ""
echo "[user] show me first 5 files in current directory"
echo "[system] Claude session started"
echo "I'll show you the files..."
echo "[tool] Bash"
echo "  command: ls | head -5, description: List first 5 files"
echo "[tool_result] file1.txt"
echo "file2.txt"
echo "..."
echo "Here are the first 5 files:"
echo "- file1.txt"
echo "- file2.txt"
echo "[✓] Command completed successfully"
echo ""
echo "==================================="
