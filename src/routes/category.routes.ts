import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all categories
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const categories = await prisma.category.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: { name: 'asc' }
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET category by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const category = await prisma.category.findUnique({
      where: { id },
      include: {
        products: true,
        skuMasters: true,
        _count: {
          select: {
            products: true,
            skuMasters: true,
          }
        }
      }
    });

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json(category);
  } catch (error: any) {
    console.error('Error fetching category by id:', error);
    res.status(500).json({ error: 'Failed to fetch category' });
  }
});

// POST new category
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const category = await prisma.category.create({
      data: { name }
    });
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// PUT update category
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;
    
    // Allow updating just the status, or just the name
    if (!name && !status) return res.status(400).json({ error: 'Data is required to update' });

    const updateData: any = {};
    if (name) updateData.name = name;
    if (status) updateData.status = status;

    const category = await prisma.category.update({
      where: { id },
      data: updateData
    });
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE category (Soft delete can be done via PUT status='Inactive', but keeping route for backward compatibility if needed, or removing it. We will just leave it as is for now, but UI won't call it).
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.category.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// POST bulk upload categories
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

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        if (!row.name) {
          errors.push(`Row ${i + 2}: Missing name`);
          continue;
        }

        await prisma.category.create({
          data: { name: row.name }
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

// POST bulk import categories (JSON array)
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    let successCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const name = (row.name || row.categoryName || row['Item Group Name'] || row.itemGroup || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);
        const status = disabled ? 'Inactive' : 'Active';

        const existing = await prisma.category.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existing) {
          await prisma.category.update({
            where: { id: existing.id },
            data: { status }
          });
          updatedCount++;
        } else {
          await prisma.category.create({
            data: { name, status }
          });
          createdCount++;
        }
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    res.json({
      message: `Successfully processed ${successCount} item groups (${createdCount} created, ${updatedCount} updated).`,
      count: successCount,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    console.error('Failed to bulk import categories:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import categories' });
  }
});

export default router;
