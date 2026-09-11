import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all SKUs
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const skus = await prisma.skuMaster.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
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
    const { name, sku, categoryId, status } = req.body;
    
    const oldSkuMaster = await prisma.skuMaster.findUnique({ where: { id } });

    const skuMaster = await prisma.$transaction(async (tx) => {
      const updateData: any = {};
      if (name) updateData.name = name;
      if (sku) updateData.sku = sku;
      if (categoryId !== undefined) updateData.categoryId = categoryId || null;
      if (status) updateData.status = status;

      const updatedSku = await tx.skuMaster.update({
        where: { id },
        data: updateData,
        include: { category: true }
      });

      if (oldSkuMaster) {
        // Auto-update Product
        const prodUpdateData: any = {};
        if (name) prodUpdateData.name = name;
        if (sku) prodUpdateData.sku = sku;
        if (categoryId !== undefined) prodUpdateData.categoryId = categoryId || null;
        if (status) prodUpdateData.status = status;

        await tx.product.updateMany({
          where: { sku: oldSkuMaster.sku },
          data: prodUpdateData
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

// POST bulk upload SKUs
router.post('/bulk-upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any>(sheet);

    let successCount = 0;
    const errors: string[] = [];

    const supplier = await prisma.supplier.findFirst();
    const category = await prisma.category.findFirst();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.name || !row.sku) {
          errors.push(`Row ${i + 2}: Missing name or SKU`);
          continue;
        }

        await prisma.$transaction(async (tx) => {
          await tx.skuMaster.create({
            data: { 
              name: row.name, 
              sku: row.sku,
              categoryId: category ? category.id : null 
            }
          });

          await tx.product.create({
            data: {
              name: row.name,
              sku: row.sku,
              supplierId: supplier ? supplier.id : 'default-will-fail-if-no-supplier',
              categoryId: category ? category.id : 'default-will-fail-if-no-category', 
              cost_price: 0,
              selling_price: 0,
              quantity: 0,
              min_stock: 0,
              status: 'Active',
              location: ''
            }
          });
        });
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    res.json({ message: `Successfully processed ${successCount} rows.`, errors });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process bulk upload' });
  }
});

export default router;
