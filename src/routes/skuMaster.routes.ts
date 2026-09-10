import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all SKUs
router.get('/', async (req: Request, res: Response) => {
  try {
    const skus = await prisma.skuMaster.findMany({
      include: { category: true },
      orderBy: { name: 'asc' }
    });
    res.json(skus);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch SKUs' });
  }
});

// POST new SKU
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, sku, categoryId } = req.body;
    if (!name || !sku) {
      return res.status(400).json({ error: 'Name and SKU are required' });
    }
    
    // First supplier fallback
    const supplier = await prisma.supplier.findFirst();

    const skuMaster = await prisma.$transaction(async (tx) => {
      const createdSku = await tx.skuMaster.create({
        data: { name, sku, categoryId: categoryId || null },
        include: { category: true }
      });

      // Auto-create Product so it appears in inventory and invoices
      await tx.product.create({
        data: {
          name,
          sku,
          categoryId: categoryId || null,
          supplierId: supplier ? supplier.id : 'default-will-fail-if-no-supplier', // This might fail if no supplier exists
          cost_price: 0,
          selling_price: 0,
          quantity: 0,
          min_stock: 0,
          status: 'Active',
          location: ''
        }
      });

      return createdSku;
    });

    res.status(201).json(skuMaster);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'SKU must be unique' });
    }
    res.status(500).json({ error: 'Failed to create SKU' });
  }
});

// PUT update SKU
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, sku, categoryId } = req.body;
    
    const oldSkuMaster = await prisma.skuMaster.findUnique({ where: { id } });

    const skuMaster = await prisma.$transaction(async (tx) => {
      const updatedSku = await tx.skuMaster.update({
        where: { id },
        data: { name, sku, categoryId: categoryId || null },
        include: { category: true }
      });

      if (oldSkuMaster) {
        // Auto-update Product
        await tx.product.updateMany({
          where: { sku: oldSkuMaster.sku },
          data: { name, sku, categoryId: categoryId || null }
        });
      }

      return updatedSku;
    });

    res.json(skuMaster);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update SKU' });
  }
});

// DELETE SKU
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const skuMaster = await prisma.skuMaster.findUnique({ where: { id } });

    await prisma.$transaction(async (tx) => {
      await tx.skuMaster.delete({ where: { id } });
      if (skuMaster) {
        await tx.product.deleteMany({ where: { sku: skuMaster.sku } });
      }
    });

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete SKU' });
  }
});

export default router;
