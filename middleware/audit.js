import { supabase } from '../config/database.js';

export const auditLog = async (req, res, next) => {
  const originalSend = res.json;
  
  res.json = async function(data) {
    // Log the action after response
    if (req.user && req.path) {
      try {
        await supabase.from('audit_logs').insert({
          user_id: req.user.id,
          action: `${req.method} ${req.path}`,
          entity_type: req.body?.type || null,
          entity_id: req.body?.id || null,
          details: {
            method: req.method,
            path: req.path,
            body: req.method !== 'GET' ? req.body : null,
            response_status: res.statusCode
          },
          ip_address: req.ip || req.connection.remoteAddress
        });
      } catch (error) {
        console.error('Audit log error:', error);
      }
    }
    return originalSend.call(this, data);
  };
  
  next();
};

