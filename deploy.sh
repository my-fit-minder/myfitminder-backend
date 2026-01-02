#!/bin/bash

# MyFitMinder Backend Deployment Script
# This script helps deploy to AWS Elastic Beanstalk

echo "🚀 MyFitMinder Backend Deployment Script"
echo "=========================================="

# Check if EB CLI is installed
if ! command -v eb &> /dev/null; then
    echo "❌ EB CLI is not installed. Please install it first:"
    echo "   brew install aws-elasticbeanstalk"
    exit 1
fi

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS CLI is not configured. Please run: aws configure"
    exit 1
fi

echo "✅ Prerequisites check passed"
echo ""

# Check if EB is initialized
if [ ! -f ".elasticbeanstalk/config.yml" ]; then
    echo "📦 Initializing Elastic Beanstalk..."
    echo "   Please follow the prompts:"
    echo "   - Choose your region (e.g., us-east-1)"
    echo "   - Application name: myfitminder-backend"
    echo "   - Platform: Node.js"
    echo "   - Platform version: Latest Node.js 18"
    eb init
fi

# Check if environment exists
if ! eb list &> /dev/null; then
    echo "🌍 Creating Elastic Beanstalk environment..."
    echo "   This may take 5-10 minutes..."
    eb create myfitminder-backend-prod
else
    echo "📤 Deploying to existing environment..."
    eb deploy
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Set environment variables:"
echo "      eb setenv SUPABASE_URL=your_url SUPABASE_SERVICE_ROLE_KEY=your_key ..."
echo "   2. Check status: eb status"
echo "   3. View logs: eb logs"
echo "   4. Open in browser: eb open"
echo ""

