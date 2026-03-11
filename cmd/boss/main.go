package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/matthewroberts/parallelagents/internal/boss"
)

func main() {
	serverURL := flag.String("server", "ws://localhost:8080/ws/boss", "server WebSocket URL")
	flag.Parse()

	ws, err := boss.NewWSClient(*serverURL)
	if err != nil {
		log.Fatalf("connect error: %v", err)
	}
	defer ws.Close()

	model := boss.NewModel(ws)
	p := tea.NewProgram(model, tea.WithAltScreen())

	ws.SetProgram(p)
	go ws.ReadPump()

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
