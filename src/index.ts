import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import inventoryRoutes, { syncProductQuantitiesWithLedger } from './routes/inventory.routes'; // TS should resolve this to inventory.routes.ts


const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// Maintenance Flag Paths
const candidateFlagPaths = [
  process.env.MAINTENANCE_FLAG_PATH,
  '/var/www/auraerp/maintenance.flag',
  path.resolve(__dirname, '../../maintenance.flag'),
  path.resolve(__dirname, '../maintenance.flag')
].filter(Boolean) as string[];

const isMaintenanceActive = () => {
  return candidateFlagPaths.some(p => fs.existsSync(p));
};

// Emergency Security Lockdown Middleware (Returns 503 when flag is present)
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/health' || req.path === '/api/system/maintenance') {
    return next();
  }

  if (isMaintenanceActive()) {
    return res.status(503).json({
      error: 'Service Temporarily Unavailable',
      message: 'Aura ERP is currently undergoing security maintenance. All requests are temporarily paused.',
      maintenance: true,
      statusCode: 503
    });
  }

  next();
});

// Maintenance Status Endpoint
app.get('/api/system/maintenance', (req, res) => {
  const active = isMaintenanceActive();
  res.json({
    maintenance: active,
    status: active ? 'LOCKED_DOWN' : 'ONLINE',
    message: active ? 'Service is temporarily unavailable (503)' : 'All systems operational'
  });
});

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, '../uploads')));

import authRoutes from './routes/auth.routes';
import supplierRoutes from './routes/supplier.routes';
import categoryRoutes from './routes/category.routes';
import unitRoutes from './routes/unit.routes';
import customerRoutes from './routes/customer.routes';
import invoiceRoutes from './routes/invoice.routes';
import skuMasterRoutes from './routes/skuMaster.routes';
import expenseRoutes from './routes/expense.routes';
import paymentRoutes from './routes/payment.routes';
import reportRoutes from './routes/report.routes';
import partOfRoutes from './routes/partOf.routes';
import subPartOfRoutes from './routes/subPartOf.routes';
import stockEntryRoutes from './routes/stockEntry.routes';
import userRoutes from './routes/user.routes';
import roleRoutes from './routes/role.routes';
import companyRoutes from './routes/company.routes';
import repackRoutes from './routes/repack.routes';
import uploadRoutes from './routes/upload.routes';
import stockCountRoutes from './routes/stockCount.routes';
import { startTelegramLockdownBot } from './services/telegramBotService';

// Routes setup
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Inventory Management API Running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/products', inventoryRoutes); // Alias for product API
app.use('/api/suppliers', supplierRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/clients', customerRoutes); // Alias for clients
app.use('/api/companies', companyRoutes);
app.use('/api/part-of', partOfRoutes);
app.use('/api/sub-part-of', subPartOfRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/skus', skuMasterRoutes);
app.use('/api/skuMaster', skuMasterRoutes); // Alias for frontend fetchSkus
app.use('/api/expenses', expenseRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/stock-entries', stockEntryRoutes);
app.use('/api/stock-ledger', stockEntryRoutes); // Alias
app.use('/api/repack', repackRoutes);
app.use('/api/stock-count', stockCountRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/bin-report', (req, res, next) => {
  req.url = '/bin-report' + req.url;
  inventoryRoutes(req, res, next);
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, async () => {
  console.log(`HTTP API Server running on port ${PORT}`);
  // Run stock reconciliation to heal any desynchronization between Product.quantity and StockLedger
  await syncProductQuantitiesWithLedger();
  // Start the Emergency Telegram Lockdown Bot if credentials are configured
  startTelegramLockdownBot();
});
