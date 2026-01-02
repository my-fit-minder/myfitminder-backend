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

3. Fill in your environment variables:
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (for backend operations)
- `SUPABASE_ANON_KEY`: Your Supabase anon key
- `STRIPE_SECRET_KEY`: Your Stripe secret key
- `STRIPE_WEBHOOK_SECRET`: Your Stripe webhook secret (for production)
- `JWT_SECRET`: A random secret for JWT tokens

4. Set up the database schema:
   - Go to your Supabase SQL editor
   - Run the SQL from `database/schema.sql`

5. Start the server:
```bash
npm run dev  # Development with nodemon
# or
npm start    # Production
```

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
- `POST /api/payments/deposit` - Create deposit payment intent
- `POST /api/payments/confirm` - Confirm payment and update balance
- `GET /api/payments/transactions` - Get payment history
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

