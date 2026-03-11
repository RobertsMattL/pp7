.PHONY: all server agent boss clean setup-agents

all: server agent boss

server:
	go build -o bin/parallelagents-server ./cmd/server

agent:
	go build -o bin/parallelagents-agent ./cmd/agent

boss:
	go build -o bin/parallelagents-boss ./cmd/boss

clean:
	rm -rf bin/

# Create 4 agent directories that are git worktrees of a target repo.
# Usage: make setup-agents REPO=/path/to/your/repo
AGENTS_DIR ?= agents
AGENT_NAMES ?= agent-1 agent-2 agent-3 agent-4

setup-agents:
ifndef REPO
	$(error REPO is required. Usage: make setup-agents REPO=/path/to/your/repo)
endif
	@mkdir -p $(AGENTS_DIR)
	@for name in $(AGENT_NAMES); do \
		if [ -d "$(AGENTS_DIR)/$$name" ]; then \
			echo "$$name already exists, skipping"; \
		else \
			echo "Creating worktree $(AGENTS_DIR)/$$name..."; \
			git -C $(REPO) worktree add $(CURDIR)/$(AGENTS_DIR)/$$name -b pa-$$name; \
		fi; \
	done
	@echo "Done. Start agents by cd-ing into each directory and running: parallelagents-agent"

clean-agents:
	@for name in $(AGENT_NAMES); do \
		if [ -d "$(AGENTS_DIR)/$$name" ]; then \
			echo "Removing worktree $(AGENTS_DIR)/$$name..."; \
			git -C $(REPO) worktree remove $(CURDIR)/$(AGENTS_DIR)/$$name --force 2>/dev/null || rm -rf $(AGENTS_DIR)/$$name; \
		fi; \
	done
	@rmdir $(AGENTS_DIR) 2>/dev/null || true
