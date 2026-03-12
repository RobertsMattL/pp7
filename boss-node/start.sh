#!/bin/bash

# Start ParallelAgents Boss Node UI
cd "$(dirname "$0")"

echo "Starting ParallelAgents Boss (Node.js Edition)..."
echo "Make sure the ParallelAgents server is running on port 8080"
echo ""

npm start
