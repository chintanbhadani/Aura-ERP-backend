import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all items (with optional search)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    
    const products = await prisma.product.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search as string, mode: 'insensitive' } },
              { sku: { contains: search as string, mode: 'insensitive' } },
            ],
          }
        : undefined,
      include: {
        category: true,
        supplier: true,
        unit: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// POST new item
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = req.body;
    // Basic validation
    if (!data.sku || !data.name || data.quantity === undefined || !data.cost_price || !data.selling_price || !data.categoryId || !data.supplierId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const product = await prisma.product.create({
      data: {
        sku: data.sku,
        name: data.name,
        quantity: parseInt(data.quantity),
        cost_price: parseFloat(data.cost_price),
        selling_price: parseFloat(data.selling_price),
        min_stock: parseInt(data.min_stock) || 0,
        categoryId: data.categoryId,
        supplierId: data.supplierId,
        unitId: data.unitId || null,
        location: data.location || '',
        status: data.status || 'Active',
      },
    });
    res.status(201).json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT update item
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const data = req.body;

    const product = await prisma.product.update({
      where: { id },
      data: {
        sku: data.sku,
        name: data.name,
        quantity: data.quantity !== undefined ? parseInt(data.quantity) : undefined,
        cost_price: data.cost_price !== undefined ? parseFloat(data.cost_price) : undefined,
        selling_price: data.selling_price !== undefined ? parseFloat(data.selling_price) : undefined,
        min_stock: data.min_stock !== undefined ? parseInt(data.min_stock) : undefined,
        categoryId: data.categoryId,
        supplierId: data.supplierId,
        unitId: data.unitId || null,
        location: data.location,
        status: data.status,
      },
    });
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE item
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.product.delete({
      where: { id },
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

export default router;
