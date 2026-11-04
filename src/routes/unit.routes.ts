import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all units
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const units = await prisma.unit.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: { name: 'asc' }
    });
    res.json(units);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch units' });
  }
});

// GET unit by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const unit = await prisma.unit.findUnique({
      where: { id },
      include: {
        products: true,
        _count: {
          select: {
            products: true,
          }
        }
      }
    });

    if (!unit) {
      return res.status(404).json({ error: 'Unit not found' });
    }

    res.json(unit);
  } catch (error: any) {
    console.error('Error fetching unit by id:', error);
    res.status(500).json({ error: 'Failed to fetch unit' });
  }
});

// POST new unit
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const unit = await prisma.unit.create({
      data: { name }
    });
    res.status(201).json(unit);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create unit' });
  }
});

// PUT update unit
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;
    if (!name && !status) return res.status(400).json({ error: 'Data is required to update' });

    const updateData: any = {};
    if (name) updateData.name = name;
    if (status) updateData.status = status;

    const unit = await prisma.unit.update({
      where: { id },
      data: updateData
    });
    res.json(unit);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update unit' });
  }
});

// DELETE unit
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.unit.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete unit' });
  }
});

// POST bulk upload units
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

        await prisma.unit.create({
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

// POST bulk import units (JSON array)
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
        const name = (row.name || row.unitName || row['Unit Name'] || row.uom || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);
        const status = disabled ? 'Inactive' : 'Active';

        const existing = await prisma.unit.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existing) {
          await prisma.unit.update({
            where: { id: existing.id },
            data: { status }
          });
          updatedCount++;
        } else {
          await prisma.unit.create({
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
      message: `Successfully processed ${successCount} units (${createdCount} created, ${updatedCount} updated).`,
      count: successCount,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    console.error('Failed to bulk import units:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import units' });
  }
});

export default router;
