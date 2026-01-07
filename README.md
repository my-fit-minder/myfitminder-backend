# MyFitMinder Backend

Backend API for the MyFitMinder fitness stakes application.

## Tech Stack

- **Node.js** with Express
- **PostgreSQL** via Supabase
- **Stripe** for payments
- **node-cron** for scheduled jobs

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

3. Fill in your environment variables in `.env`:

   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (for backend operations)
   - `SUPABASE_ANON_KEY`: Your Supabase anon key
   - `JWT_SECRET`: A random secret for JWT tokens
   - `PORT`: Server port (default: 3000)
   - `NODE_ENV`: Environment (development/production)
   - `FRONTEND_URL`: Frontend URL for CORS (optional)

   **Stripe Configuration:**

   - For **test mode** (App Review):
     ```env
     STRIPE_MODE=test
     STRIPE_TEST_SECRET_KEY=sk_test_...
     STRIPE_TEST_PUBLISHABLE_KEY=pk_test_...
     ```
   - For **live mode** (Production):
     ```env
     STRIPE_MODE=live
     STRIPE_LIVE_SECRET_KEY=sk_live_...
     STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_...
     ```
   - Legacy (still works):
     ```env
     STRIPE_SECRET_KEY=sk_test_... or sk_live_...
     STRIPE_PUBLISHABLE_KEY=pk_test_... or pk_live_...
     ```
   - `STRIPE_WEBHOOK_SECRET`: Your Stripe webhook secret (for production)
   - `STRIPE_ACCOUNT_COUNTRY`: Account country code (default: "ca")

4. Set up the database schema:

   - Go to your Supabase SQL editor
   - Run the SQL from `database/schema.sql`

5. Start the server:

```bash
npm run dev  # Development with nodemon
# or
npm start    # Production
```

## Updating Environment Variables

### Local Development

1. **Edit the `.env` file** in the project root:

   ```bash
   nano .env
   # or
   code .env
   ```

2. **Save your changes**

3. **Restart the server:**
   - If using `npm run dev` (nodemon): The server will auto-restart
   - If using `npm start`: Stop the server (Ctrl+C) and restart:
     ```bash
     npm start
     ```

### Production (PM2)

If using PM2 process manager:

1. **Update environment variables:**

   ```bash
   # Edit .env file
   nano .env
   ```

2. **Restart the application:**

   ```bash
   pm2 restart myfitminder-backend
   # or by process name/ID
   pm2 restart all
   ```

3. **Verify it's running:**
   ```bash
   pm2 status
   pm2 logs myfitminder-backend
   ```

### Production (systemd)

If using systemd service:

1. **Update environment variables:**

   ```bash
   # Edit the service file (usually in /etc/systemd/system/)
   sudo nano /etc/systemd/system/myfitminder-backend.service
   # Or edit .env file if using EnvironmentFile directive
   sudo nano /path/to/myfitminder-backend/.env
   ```

2. **Reload systemd and restart:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart myfitminder-backend
   ```

3. **Check status:**
   ```bash
   sudo systemctl status myfitminder-backend
   ```

### Production (AWS EC2)

1. **SSH into your EC2 instance:**

   ```bash
   ssh -i /path/to/your-key.pem ec2-user@your-ec2-ip
   # or for Ubuntu instances
   ssh -i /path/to/your-key.pem ubuntu@your-ec2-ip
   ```

2. **Navigate to your project directory:**

   ```bash
   cd /path/to/myfitminder-backend
   # Common locations:
   # /home/ec2-user/myfitminder-backend
   # /home/ubuntu/myfitminder-backend
   # /var/www/myfitminder-backend
   ```

3. **Update the `.env` file:**

   ```bash
   nano .env
   # or
   vi .env
   ```

   Edit your environment variables:

   ```env
   STRIPE_MODE=live
   STRIPE_LIVE_SECRET_KEY=sk_live_...
   STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_...
   STRIPE_ACCOUNT_COUNTRY=ca
   ```

4. **Restart the server** (choose one method based on how you're running it):

   **If using PM2 (recommended):**

   ```bash
   pm2 restart myfitminder-backend
   # or restart all processes
   pm2 restart all
   # Check status
   pm2 status
   pm2 logs myfitminder-backend
   ```

   **If using systemd:**

   ```bash
   sudo systemctl restart myfitminder-backend
   # Check status
   sudo systemctl status myfitminder-backend
   # View logs
   sudo journalctl -u myfitminder-backend -f
   ```

   **If using npm directly (not recommended for production):**

   ```bash
   # Find and kill the process
   ps aux | grep node
   kill <PID>
   # Or kill all node processes (be careful!)
   pkill -f "node server.js"
   # Restart
   nohup npm start > server.log 2>&1 &
   # Or better: use PM2
   pm2 start npm --name "myfitminder-backend" -- start
   ```

5. **Verify the server is running:**
   ```bash
   # Check if port is listening
   netstat -tulpn | grep :3000
   # or
   ss -tulpn | grep :3000
   # Test the health endpoint
   curl http://localhost:3000/health
   # Test the publishable key endpoint
   curl http://localhost:3000/api/payments/publishable-key
   ```

### Production (AWS Elastic Beanstalk)

1. **Update environment variables:**

   ```bash
   eb setenv \
     STRIPE_MODE=live \
     STRIPE_LIVE_SECRET_KEY=sk_live_... \
     STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_... \
     STRIPE_ACCOUNT_COUNTRY=ca
   ```

2. **The environment will automatically restart** after setting variables

3. **Verify:**
   ```bash
   eb status
   eb logs
   ```

### Production (Docker)

If running in Docker:

1. **Update environment variables:**

   - Edit `.env` file or docker-compose.yml
   - Or pass via `-e` flags

2. **Restart container:**
   ```bash
   docker-compose restart
   # or
   docker restart myfitminder-backend
   ```

## Switching Stripe from Test to Live

1. **Update `.env` file:**

   ```env
   STRIPE_MODE=live
   STRIPE_LIVE_SECRET_KEY=sk_live_YOUR_LIVE_SECRET_KEY
   STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_YOUR_LIVE_PUBLISHABLE_KEY
   ```

2. **Restart the server** (see methods above)

3. **Verify the publishable key endpoint:**

   ```bash
   curl https://api.myfitminder.app/api/payments/publishable-key
   ```

   Should return:

   ```json
   {
     "publishableKey": "pk_live_...",
     "mode": "live"
   }
   ```

4. **Update Stripe webhooks** to use live mode endpoints

See `../STRIPE_TEST_TO_LIVE_GUIDE.md` for detailed instructions.

## API Endpoints

### Authentication

- `POST /api/auth/signup` - Register new user
- `POST /api/auth/signin` - Sign in
- `GET /api/auth/me` - Get current user (requires auth)

### Goals

- `GET /api/goals` - Get all user goals
- `GET /api/goals/:id` - Get single goal with logs and penalties
- `POST /api/goals` - Create new goal
- `PUT /api/goals/:id` - Update goal (status)
- `DELETE /api/goals/:id` - Cancel goal

### Workouts

- `POST /api/workouts` - Submit workout log
- `POST /api/workouts/batch` - Batch submit workout logs
- `GET /api/workouts` - Get workout logs (with optional filters)

### Payments

- `GET /api/payments/publishable-key` - Get Stripe publishable key (public, no auth)
- `POST /api/payments/deposit` - Create deposit payment intent
- `POST /api/payments/confirm` - Confirm payment and update balance
- `GET /api/payments/transactions` - Get payment history
- `POST /api/payments/request-payout` - Request payout of wallet balance
- `POST /api/payments/refund` - Process refund
- `POST /api/payments/webhook` - Stripe webhook handler

## Scheduled Jobs

The server automatically runs penalty calculations every Sunday at 11 PM. In development, you can manually trigger it:

```bash
POST /api/admin/calculate-penalties
```

## Stripe Webhook Setup

1. Install Stripe CLI: https://stripe.com/docs/stripe-cli
2. Forward webhooks to local server:

```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

3. Copy the webhook secret to your `.env` file

## Database Schema

See `database/schema.sql` for the complete schema. Key tables:

- `users` - User accounts
- `goals` - Fitness goals
- `workout_logs` - Daily workout data
- `commitment_balances` - User deposit balances
- `payment_transactions` - Payment history
- `penalty_records` - Weekly penalty calculations
- `audit_logs` - Audit trail
