#!/bin/bash

# Deploy script for VeeriBot

echo "🚀 Deploying VeeriBot..."

# Build the project
echo "Building project..."
npm run build

# Run database migrations
echo "🗄️ Running database migrations..."
npm run db:migrate

echo "deployment complete!"
echo ""
echo "To start:"
echo "  npm start"
echo ""
echo "For dev:"
echo "  npm run dev"