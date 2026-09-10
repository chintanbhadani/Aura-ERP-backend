import express from 'express';
import cors from 'cors';
import inventoryRoutes from './routes/inventory.routes'; // TS should resolve this to inventory.routes.ts


const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

import authRoutes from './routes/auth.routes';
import supplierRoutes from './routes/supplier.routes';
import categoryRoutes from './routes/category.routes';
import unitRoutes from './routes/unit.routes';
import customerRoutes from './routes/customer.routes';
import invoiceRoutes from './routes/invoice.routes';
import skuMasterRoutes from './routes/skuMaster.routes';
import expenseRoutes from './routes/expense.routes';

// Routes setup
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Inventory Management API Running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/products', inventoryRoutes); // Alias for product API
app.use('/api/suppliers', supplierRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/skus', skuMasterRoutes);
app.use('/api/expenses', expenseRoutes);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`HTTP API Server running on port ${PORT}`);
});
