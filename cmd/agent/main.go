package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/matthewroberts/parallelagents/internal/agent"
)

func main() {
	name := flag.String("name", "", "agent name (defaults to current directory name)")
	serverURL := flag.String("server", "ws://localhost:8080/ws/agent", "server WebSocket URL")
	workdir := flag.String("workdir", "", "working directory for claude commands (defaults to current directory)")
	flag.Parse()

	// Default workdir to current directory.
	if *workdir == "" {
		cwd, err := os.Getwd()
		if err != nil {
			log.Fatalf("failed to get working directory: %v", err)
		}
		*workdir = cwd
	}

	// Default name to the directory name.
	if *name == "" {
		*name = filepath.Base(*workdir)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	a := agent.New(*name, *serverURL, *workdir, nil)
	if err := a.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("agent error: %v", err)
	}
	log.Println("agent stopped")
}
