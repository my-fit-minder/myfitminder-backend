import express from "express";
import { supabase, supabaseClient } from "../config/database.js";
import jwt from "jsonwebtoken";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router();

// Sign up
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    if (!authData.user) {
      return res.status(400).json({ error: "Failed to create user" });
    }

    // Create user record in our users table
    const { error: dbError } = await supabase.from("users").insert({
      id: authData.user.id,
      email: authData.user.email,
      currency: "usd", // Default currency
    });

    if (dbError) {
      // If user creation fails, try to clean up auth user
      console.error("Database error:", dbError);
      return res.status(500).json({ error: "Failed to create user record" });
    }

    // Create initial balance record
    await supabase.from("commitment_balances").insert({
      user_id: authData.user.id,
      total_deposit: 0,
      available_balance: 0,
      pending_penalties: 0,
      total_payout: 0,
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: authData.user.id, email: authData.user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: authData.user.id,
        email: authData.user.email,
      },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Sign in
router.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // Sign in with Supabase
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError || !authData.user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Get user from database
    const { data: user, error: dbError } = await supabase
      .from("users")
      .select("id, email, stripe_customer_id, default_payment_method_id")
      .eq("id", authData.user.id)
      .single();

    if (dbError || !user) {
      return res.status(500).json({ error: "User not found" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user,
    });
  } catch (error) {
    console.error("Signin error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get current user
router.get("/me", authenticateToken, async (req, res) => {
  try {
    // Fetch full user data to ensure all fields are included
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select(
        "id, email, stripe_customer_id, default_payment_method_id, currency, name, date_of_birth"
      )
      .eq("id", req.user.id)
      .single();

    if (userError || !userData) {
      console.error("Error fetching user data:", userError);
      return res.status(500).json({ error: "Failed to fetch user data" });
    }

    const { data: balance } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    // Ensure total_payout is included (default to 0 if column doesn't exist)
    const balanceData = balance || {
      total_deposit: 0,
      available_balance: 0,
      pending_penalties: 0,
      total_payout: 0,
    };

    // If balance exists but total_payout is null/undefined, set it to 0
    if (
      balance &&
      (balance.total_payout === null || balance.total_payout === undefined)
    ) {
      balanceData.total_payout = 0;
    } else if (balance) {
      balanceData.total_payout = balance.total_payout || 0;
    }

    res.json({
      user: userData,
      balance: balanceData,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Request password reset
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    // Get the base URL from environment or use a default
    const baseUrl =
      process.env.APP_URL ||
      process.env.SUPABASE_URL ||
      "http://localhost:3000";
    const redirectUrl = `${baseUrl}/api/auth/reset-password-callback`;

    // Send password reset email via Supabase
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl,
    });

    if (error) {
      console.error("Password reset error:", error);
      return res.status(400).json({ error: error.message });
    }

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      message:
        "If an account exists with this email, a password reset link has been sent.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Reset password with token
router.post("/reset-password", async (req, res) => {
  try {
    // Get token from Authorization header or body
    const authHeader = req.headers.authorization;
    const tokenFromHeader =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;
    const tokenFromBody = req.body.token;
    const accessToken = tokenFromHeader || tokenFromBody;
    const { newPassword } = req.body;

    if (!accessToken || !newPassword) {
      return res.status(400).json({ error: "Token and new password required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    // Create a Supabase client with the access token in headers
    const { createClient } = await import("@supabase/supabase-js");
    const supabaseWithToken = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      }
    );

    // Verify the token and get the user
    const {
      data: { user },
      error: userError,
    } = await supabaseWithToken.auth.getUser();

    if (userError || !user) {
      console.error("Get user error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // Update password using Supabase Admin API via REST
    // We use the service role key to update the user's password
    const adminResponse = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          password: newPassword,
        }),
      }
    );

    if (!adminResponse.ok) {
      const errorData = await adminResponse.json();
      console.error("Reset password error:", errorData);
      return res.status(400).json({
        error:
          errorData.error_description ||
          errorData.message ||
          "Failed to reset password",
      });
    }

    res.json({
      success: true,
      message: "Password has been reset successfully",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handle password reset callback from Supabase email
router.get("/reset-password-callback", async (req, res) => {
  try {
    console.log("Password reset callback accessed:", req.path, req.query);
    // Supabase sends tokens as hash fragments (#access_token=...), not query params
    // Hash fragments are not sent to the server, so we need a client-side page
    // that extracts the hash and makes the API call

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Reset Password - MyFitMinder</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: #0E1117;
            color: #E6EDF3;
            padding: 20px;
          }
          .container {
            background: #161B22;
            padding: 2rem;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            max-width: 400px;
            width: 100%;
          }
          h1 {
            color: #E6EDF3;
            margin-bottom: 0.5rem;
            font-size: 1.5rem;
          }
          .subtitle {
            color: #9BA3AF;
            margin-bottom: 1.5rem;
            font-size: 0.9rem;
          }
          .form-group {
            margin-bottom: 1rem;
          }
          label {
            display: block;
            color: #E6EDF3;
            margin-bottom: 0.5rem;
            font-size: 0.9rem;
          }
          input {
            width: 100%;
            padding: 12px;
            background: #0E1117;
            border: 1px solid #1F8A70;
            border-radius: 8px;
            color: #E6EDF3;
            font-size: 1rem;
          }
          input:focus {
            outline: none;
            border-color: #1F8A70;
            box-shadow: 0 0 0 3px rgba(31, 138, 112, 0.1);
          }
          button {
            width: 100%;
            padding: 12px;
            background: #1F8A70;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            margin-top: 1rem;
          }
          button:hover {
            background: #166B55;
          }
          button:disabled {
            background: #9BA3AF;
            cursor: not-allowed;
          }
          .message {
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
          }
          .success {
            background: rgba(63, 207, 142, 0.1);
            color: #3FCF8E;
            border: 1px solid #3FCF8E;
          }
          .error {
            background: rgba(229, 83, 61, 0.1);
            color: #E5533D;
            border: 1px solid #E5533D;
          }
          .loading {
            text-align: center;
            color: #9BA3AF;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Reset Your Password</h1>
          <p class="subtitle">Enter your new password below</p>
          
          <div id="message"></div>
          
          <form id="resetForm">
            <div class="form-group">
              <label for="password">New Password</label>
              <input type="password" id="password" name="password" required minlength="6" autocomplete="new-password">
            </div>
            <div class="form-group">
              <label for="confirmPassword">Confirm Password</label>
              <input type="password" id="confirmPassword" name="confirmPassword" required minlength="6" autocomplete="new-password">
            </div>
            <button type="submit" id="submitBtn">Reset Password</button>
          </form>
          
          <div id="loading" class="loading" style="display: none;">Resetting password...</div>
        </div>
        
        <script>
          // Extract access_token from hash fragment
          function getHashParams() {
            const hash = window.location.hash.substring(1);
            const params = {};
            hash.split('&').forEach(param => {
              const [key, value] = param.split('=');
              if (key && value) {
                params[decodeURIComponent(key)] = decodeURIComponent(value);
              }
            });
            return params;
          }
          
          const params = getHashParams();
          const accessToken = params.access_token;
          const type = params.type;
          
          if (!accessToken || type !== 'recovery') {
            document.getElementById('message').innerHTML = 
              '<div class="message error">Invalid or expired reset link. Please request a new password reset.</div>';
            document.getElementById('resetForm').style.display = 'none';
          }
          
          document.getElementById('resetForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const messageDiv = document.getElementById('message');
            const submitBtn = document.getElementById('submitBtn');
            const loadingDiv = document.getElementById('loading');
            
            // Validate passwords match
            if (password !== confirmPassword) {
              messageDiv.innerHTML = '<div class="message error">Passwords do not match.</div>';
              return;
            }
            
            if (password.length < 6) {
              messageDiv.innerHTML = '<div class="message error">Password must be at least 6 characters.</div>';
              return;
            }
            
            // Disable form
            submitBtn.disabled = true;
            loadingDiv.style.display = 'block';
            messageDiv.innerHTML = '';
            
            try {
              // Get the base URL (remove /api/auth/reset-password-callback)
              const baseUrl = window.location.origin;
              
              // Call the reset password API
              const response = await fetch(baseUrl + '/api/auth/reset-password', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + accessToken
                },
                body: JSON.stringify({
                  token: accessToken,
                  newPassword: password
                })
              });
              
              const data = await response.json();
              
              if (response.ok) {
                messageDiv.innerHTML = '<div class="message success">Password reset successfully! You can now close this page and sign in with your new password.</div>';
                document.getElementById('resetForm').style.display = 'none';
              } else {
                messageDiv.innerHTML = '<div class="message error">' + (data.error || 'Failed to reset password. Please try again.') + '</div>';
                submitBtn.disabled = false;
              }
            } catch (error) {
              messageDiv.innerHTML = '<div class="message error">An error occurred. Please try again.</div>';
              submitBtn.disabled = false;
            } finally {
              loadingDiv.style.display = 'none';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Reset password callback error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Verify email
router.post("/verify-email", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    // Get the base URL from environment
    const baseUrl =
      process.env.APP_URL ||
      process.env.SUPABASE_URL ||
      "http://localhost:3000";
    const redirectUrl = `${baseUrl}/api/auth/verify-email-callback`;

    // Resend verification email
    const { data, error } = await supabase.auth.resend({
      type: "signup",
      email: email,
      options: {
        emailRedirectTo: redirectUrl,
      },
    });

    if (error) {
      console.error("Verify email error:", error);
      return res.status(400).json({ error: error.message });
    }

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      message:
        "If an account exists with this email, a verification link has been sent.",
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Handle email verification callback from Supabase email
router.get("/verify-email-callback", async (req, res) => {
  try {
    console.log("Email verification callback accessed:", req.path, req.query);
    // Supabase sends tokens as hash fragments (#access_token=...), not query params
    // Hash fragments are not sent to the server, so we need a client-side page
    // that extracts the hash and confirms verification

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Email Verified - MyFitMinder</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: #0E1117;
            color: #E6EDF3;
            padding: 20px;
          }
          .container {
            background: #161B22;
            padding: 2rem;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            max-width: 400px;
            width: 100%;
            text-align: center;
          }
          h1 {
            color: #E6EDF3;
            margin-bottom: 0.5rem;
            font-size: 1.5rem;
          }
          .subtitle {
            color: #9BA3AF;
            margin-bottom: 1.5rem;
            font-size: 0.9rem;
          }
          .message {
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
          }
          .success {
            background: rgba(63, 207, 142, 0.1);
            color: #3FCF8E;
            border: 1px solid #3FCF8E;
          }
          .error {
            background: rgba(229, 83, 61, 0.1);
            color: #E5533D;
            border: 1px solid #E5533D;
          }
          .loading {
            text-align: center;
            color: #9BA3AF;
            margin-top: 1rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Email Verification</h1>
          <p class="subtitle">Verifying your email address...</p>
          
          <div id="message"></div>
          <div id="loading" class="loading">Processing...</div>
        </div>
        
        <script>
          // Extract access_token from hash fragment
          function getHashParams() {
            const hash = window.location.hash.substring(1);
            const params = {};
            hash.split('&').forEach(param => {
              const [key, value] = param.split('=');
              if (key && value) {
                params[decodeURIComponent(key)] = decodeURIComponent(value);
              }
            });
            return params;
          }
          
          const params = getHashParams();
          const accessToken = params.access_token;
          const type = params.type;
          
          const messageDiv = document.getElementById('message');
          const loadingDiv = document.getElementById('loading');
          
          // Email verification is automatically handled by Supabase when the link is clicked
          // We just need to show a success message
          if (accessToken && (type === 'signup' || type === 'email')) {
            // Email is verified automatically by Supabase
            messageDiv.innerHTML = '<div class="message success">Your email has been successfully verified!</div>';
            loadingDiv.style.display = 'none';
            messageDiv.innerHTML += '<p style="margin-top: 1rem; color: #9BA3AF;">You can now close this page and return to the MyFitMinder app to sign in.</p>';
          } else {
            messageDiv.innerHTML = '<div class="message error">Invalid or expired verification link. Please request a new verification email.</div>';
            loadingDiv.style.display = 'none';
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Verify email callback error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update user profile
router.put("/profile", authenticateToken, async (req, res) => {
  try {
    const { name, date_of_birth, currency } = req.body;
    const userId = req.user.id;

    // Validate currency if provided (USD and CAD only)
    const validCurrencies = ["usd", "cad"];
    if (currency && !validCurrencies.includes(currency.toLowerCase())) {
      return res.status(400).json({
        error: "Invalid currency code. Only USD and CAD are supported.",
      });
    }

    // Validate date_of_birth if provided
    if (date_of_birth !== undefined) {
      const dob = new Date(date_of_birth);
      const today = new Date();
      let age = today.getFullYear() - dob.getFullYear();
      const monthDiff = today.getMonth() - dob.getMonth();

      if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getDate() < dob.getDate())
      ) {
        age--;
      }

      if (age > 120) {
        return res
          .status(400)
          .json({ error: "Please enter a valid date of birth" });
      }

      if (dob > today) {
        return res
          .status(400)
          .json({ error: "Date of birth cannot be in the future" });
      }
    }

    // Build update object
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (date_of_birth !== undefined) updateData.date_of_birth = date_of_birth;
    if (currency !== undefined) updateData.currency = currency.toLowerCase();

    // Check if there's anything to update
    if (Object.keys(updateData).length === 0) {
      // Nothing to update, just fetch the current user
      const { data: userData, error: fetchError } = await supabase
        .from("users")
        .select(
          "id, email, stripe_customer_id, default_payment_method_id, currency, name, date_of_birth"
        )
        .eq("id", userId)
        .single();

      if (fetchError || !userData) {
        console.error("Fetch user error:", fetchError);
        return res.status(404).json({ error: "User not found" });
      }

      // Get balance for response
      const { data: balance } = await supabase
        .from("commitment_balances")
        .select("*")
        .eq("user_id", userId)
        .single();

      const balanceData = balance || {
        total_deposit: 0,
        available_balance: 0,
        pending_penalties: 0,
        total_payout: 0,
      };

      if (
        balance &&
        (balance.total_payout === null || balance.total_payout === undefined)
      ) {
        balanceData.total_payout = 0;
      } else if (balance) {
        balanceData.total_payout = balance.total_payout || 0;
      }

      return res.json({
        success: true,
        user: userData,
        balance: balanceData,
      });
    }

    // Update user
    const { data: updatedUser, error: updateError } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", userId)
      .select(
        "id, email, stripe_customer_id, default_payment_method_id, currency, name, date_of_birth"
      );

    if (updateError) {
      console.error("Update profile error:", updateError);
      return res.status(400).json({ error: updateError.message });
    }

    // If update returned 0 rows, the user might not exist or RLS is blocking
    let data;
    if (!updatedUser || updatedUser.length === 0) {
      // Try to fetch the user to see if they exist
      const { data: userData, error: fetchError } = await supabase
        .from("users")
        .select(
          "id, email, stripe_customer_id, default_payment_method_id, currency, name, date_of_birth"
        )
        .eq("id", userId)
        .single();

      if (fetchError || !userData) {
        console.error("User not found after update attempt:", fetchError);
        return res.status(404).json({ error: "User not found" });
      }

      // User exists but update didn't return data, use fetched data
      data = userData;
    } else {
      // Update succeeded, use the returned data
      data = updatedUser[0];
    }

    // Get balance for response
    const { data: balance } = await supabase
      .from("commitment_balances")
      .select("*")
      .eq("user_id", userId)
      .single();

    const balanceData = balance || {
      total_deposit: 0,
      available_balance: 0,
      pending_penalties: 0,
      total_payout: 0,
    };

    // Ensure total_payout is included
    if (
      balance &&
      (balance.total_payout === null || balance.total_payout === undefined)
    ) {
      balanceData.total_payout = 0;
    } else if (balance) {
      balanceData.total_payout = balance.total_payout || 0;
    }

    res.json({
      success: true,
      user: data,
      balance: balanceData,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Change password (requires authentication)
router.post("/change-password", authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Current password and new password required" });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "New password must be at least 6 characters" });
    }

    // Verify current password by attempting to sign in
    const { data: signInData, error: signInError } =
      await supabase.auth.signInWithPassword({
        email: req.user.email,
        password: currentPassword,
      });

    if (signInError || !signInData.user) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Update password using Supabase Admin API
    const adminResponse = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          password: newPassword,
        }),
      }
    );

    if (!adminResponse.ok) {
      const errorData = await adminResponse.json();
      console.error("Change password error:", errorData);
      return res.status(400).json({
        error:
          errorData.error_description ||
          errorData.message ||
          "Failed to change password",
      });
    }

    res.json({
      success: true,
      message: "Password has been changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
