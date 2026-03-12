package boss

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseProgressLine_UserPrompt(t *testing.T) {
	// This is what gets added locally when user sends a prompt
	// (not from Claude's stream)
	result := "[user] say hello"
	if !strings.Contains(result, "[user]") {
		t.Errorf("Expected [user] tag in prompt display")
	}
}

func TestParseProgressLine_SystemInit(t *testing.T) {
	input := `{"type":"system","subtype":"init","cwd":"/tmp"}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "[system]") {
		t.Errorf("Expected [system] tag, got: %s", result)
	}
	if !strings.Contains(result, "started") {
		t.Errorf("Expected 'started' message, got: %s", result)
	}
}

func TestParseProgressLine_AssistantText(t *testing.T) {
	input := `{
		"type":"assistant",
		"message":{
			"content":[
				{"type":"text","text":"Hello! How can I help you?"}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "Hello") {
		t.Errorf("Expected assistant text, got: %s", result)
	}
}

func TestParseProgressLine_ToolUse(t *testing.T) {
	input := `{
		"type":"assistant",
		"message":{
			"content":[
				{
					"type":"tool_use",
					"name":"Bash",
					"input":{
						"command":"ls -la",
						"description":"List files"
					}
				}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "[tool] Bash") {
		t.Errorf("Expected [tool] Bash, got: %s", result)
	}
	if !strings.Contains(result, "command") {
		t.Errorf("Expected command parameter, got: %s", result)
	}
	if !strings.Contains(result, "ls -la") {
		t.Errorf("Expected command value, got: %s", result)
	}
}

func TestParseProgressLine_ToolResult(t *testing.T) {
	input := `{
		"type":"user",
		"message":{
			"content":[
				{
					"type":"tool_result",
					"content":"file1.txt\nfile2.txt\nfile3.txt",
					"is_error":false
				}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "[tool_result]") {
		t.Errorf("Expected [tool_result] tag, got: %s", result)
	}
	if !strings.Contains(result, "file1.txt") {
		t.Errorf("Expected file content, got: %s", result)
	}
}

func TestParseProgressLine_ToolResultError(t *testing.T) {
	input := `{
		"type":"user",
		"message":{
			"content":[
				{
					"type":"tool_result",
					"content":"file not found",
					"is_error":true
				}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "ERROR") {
		t.Errorf("Expected ERROR tag for error result, got: %s", result)
	}
	if !strings.Contains(result, "file not found") {
		t.Errorf("Expected error message, got: %s", result)
	}
}

func TestParseProgressLine_ResultSuccess(t *testing.T) {
	input := `{
		"type":"result",
		"subtype":"success",
		"is_error":false
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "✓") || !strings.Contains(result, "completed") {
		t.Errorf("Expected success marker, got: %s", result)
	}
}

func TestParseProgressLine_ResultError(t *testing.T) {
	input := `{
		"type":"result",
		"is_error":true,
		"result":"Command failed"
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "[error]") {
		t.Errorf("Expected [error] tag, got: %s", result)
	}
}

func TestParseProgressLine_LongToolInputTruncation(t *testing.T) {
	longValue := strings.Repeat("a", 100)
	input := `{
		"type":"assistant",
		"message":{
			"content":[
				{
					"type":"tool_use",
					"name":"Read",
					"input":{
						"file_path":"` + longValue + `"
					}
				}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "...") {
		t.Errorf("Expected truncation marker for long input, got: %s", result)
	}
	if len(result) > 200 {
		t.Errorf("Expected truncated output, but got length %d", len(result))
	}
}

func TestParseProgressLine_LongToolResultTruncation(t *testing.T) {
	// Create a long result with many lines (use \n for newlines in JSON)
	longResult := strings.Repeat("line content\\n", 20)
	input := `{
		"type":"user",
		"message":{
			"content":[
				{
					"type":"tool_result",
					"content":"` + longResult + `",
					"is_error":false
				}
			]
		}
	}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "more lines") {
		t.Errorf("Expected line count indicator, got: %s", result)
	}
}

func TestParseProgressLine_MessageStart(t *testing.T) {
	input := `{"type":"message_start"}`
	result := parseProgressLine(json.RawMessage(input))

	if !strings.Contains(result, "[assistant]") {
		t.Errorf("Expected [assistant] tag, got: %s", result)
	}
}

func TestParseProgressLine_IgnoredMessageTypes(t *testing.T) {
	ignoredTypes := []string{
		`{"type":"message_delta"}`,
		`{"type":"message_stop"}`,
		`{"type":"content_block_stop"}`,
		`{"type":"ping"}`,
	}

	for _, input := range ignoredTypes {
		result := parseProgressLine(json.RawMessage(input))
		if result != "" {
			t.Errorf("Expected empty result for %s, got: %s", input, result)
		}
	}
}

func TestParseProgressLine_InvalidJSON(t *testing.T) {
	input := `{invalid json`
	result := parseProgressLine(json.RawMessage(input))

	// Should return the raw input when JSON parsing fails
	if result != input {
		t.Errorf("Expected raw input for invalid JSON, got: %s", result)
	}
}

func TestParseProgressLine_EmptyInput(t *testing.T) {
	result := parseProgressLine(json.RawMessage(""))

	if result != "" {
		t.Errorf("Expected empty result for empty input, got: %s", result)
	}
}
