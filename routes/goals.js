import express from 'express';
import { supabase } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Debug flag - set to true to enable verbose logging
const DEBUG_LOGGING_ENABLED = process.env.DEBUG_LOGGING === 'true' || false;

// Get all goals for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: goals, error } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ goals });
  } catch (error) {
    console.error('Get goals error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single goal
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: goal, error } = await supabase
      .from('goals')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    // Get workout logs for this goal
    const { data: logs } = await supabase
      .from('workout_logs')
      .select('*')
      .eq('goal_id', goal.id)
      .order('date', { ascending: true });

    // Get penalty records
    const { data: penalties } = await supabase
      .from('penalty_records')
      .select('*')
      .eq('goal_id', goal.id)
      .order('week_start_date', { ascending: false });

    res.json({
      goal,
      logs: logs || [],
      penalties: penalties || [],
    });
  } catch (error) {
    console.error('Get goal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new goal
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      frequency_per_week,
      min_duration_minutes,
      stake_amount,
      start_date,
      end_date,
      type = 'exercise',
    } = req.body;

    // Validation
    if (!frequency_per_week || !min_duration_minutes || !stake_amount || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (frequency_per_week < 1 || frequency_per_week > 7) {
      return res.status(400).json({ error: 'Frequency must be between 1 and 7' });
    }

    if (min_duration_minutes <= 0) {
      return res.status(400).json({ error: 'Minimum duration must be positive' });
    }

    if (stake_amount <= 0) {
      return res.status(400).json({ error: 'Stake amount must be positive' });
    }

    // Validate minimum stake per week = frequency × $10
    const minimumStakePerWeek = frequency_per_week * 10;
    if (stake_amount < minimumStakePerWeek) {
      return res.status(400).json({ 
        error: `Stake amount must be at least $${minimumStakePerWeek} per week (frequency × $10)` 
      });
    }

    // Parse dates - they should come as ISO8601 datetime strings
    // start_date should be start of day, end_date should be end of day
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);

    if (isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'Invalid start_date format. Expected ISO8601 datetime.' });
    }

    if (isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid end_date format. Expected ISO8601 datetime.' });
    }

    if (endDate <= startDate) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }

    // Ensure dates are stored as ISO8601 strings with timezone
    // Supabase will convert to UTC automatically
    const startDateISO = startDate.toISOString();
    const endDateISO = endDate.toISOString();

    if (DEBUG_LOGGING_ENABLED) {
      console.log('📅 Goal date conversion:');
      console.log('   Original start_date:', start_date);
      console.log('   Parsed start_date:', startDate);
      console.log('   ISO start_date:', startDateISO);
      console.log('   Original end_date:', end_date);
      console.log('   Parsed end_date:', endDate);
      console.log('   ISO end_date:', endDateISO);
    }

    // Calculate deposit amount (2 weeks worth)
    // Stake amount is per week, so deposit = stake_amount × 2
    const depositAmount = stake_amount * 2;

    const { data: goal, error } = await supabase
      .from('goals')
      .insert({
        user_id: req.user.id,
        type,
        frequency_per_week,
        min_duration_minutes,
        stake_amount,
        start_date: startDateISO,
        end_date: endDateISO,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ goal });
  } catch (error) {
    console.error('Create goal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update goal
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { status, end_date } = req.body;

    const updateData = { updated_at: new Date().toISOString() };

    // Allow status updates
    if (status && ['active', 'canceled', 'completed'].includes(status)) {
      updateData.status = status;
    }

    // Allow end_date updates (for stopping goal at end of current week)
    if (end_date) {
      const endDate = new Date(end_date);
      
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({ error: 'Invalid end_date format. Expected ISO8601 datetime.' });
      }
      
      // Convert to ISO8601 string with timezone
      updateData.end_date = endDate.toISOString();
      
      if (DEBUG_LOGGING_ENABLED) {
        console.log('📅 Goal end_date update:');
        console.log('   Original end_date:', end_date);
        console.log('   Parsed end_date:', endDate);
        console.log('   ISO end_date:', updateData.end_date);
      }
    }

    // Must update at least one field
    if (Object.keys(updateData).length === 1) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data: goal, error } = await supabase
      .from('goals')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    res.json({ goal });
  } catch (error) {
    console.error('Update goal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete goal (soft delete by setting status to canceled)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: goal, error } = await supabase
      .from('goals')
      .update({ status: 'canceled', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    res.json({ message: 'Goal canceled', goal });
  } catch (error) {
    console.error('Delete goal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all penalties for user (across all goals)
router.get('/penalties/all', authenticateToken, async (req, res) => {
  try {
    // Get all user's goals
    const { data: goals, error: goalsError } = await supabase
      .from('goals')
      .select('id')
      .eq('user_id', req.user.id);

    if (goalsError) {
      return res.status(500).json({ error: goalsError.message });
    }

    if (!goals || goals.length === 0) {
      return res.json({ penalties: [] });
    }

    const goalIds = goals.map(g => g.id);

    // Get all penalty records for user's goals
    const { data: penalties, error: penaltiesError } = await supabase
      .from('penalty_records')
      .select('*')
      .in('goal_id', goalIds)
      .order('week_start_date', { ascending: false });

    if (penaltiesError) {
      return res.status(500).json({ error: penaltiesError.message });
    }

    res.json({ penalties: penalties || [] });
  } catch (error) {
    console.error('Get penalties error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

