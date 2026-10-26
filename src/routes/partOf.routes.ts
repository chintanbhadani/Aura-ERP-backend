import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();
const prisma = new PrismaClient();

// GET all part-of items
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    const items = await prisma.partOf.findMany({
      where: search
        ? {
            name: {
              contains: search as string,
              mode: 'insensitive',
            },
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (error) {
    console.error('Error fetching PartOf:', error);
    res.status(500).json({ error: 'Failed to fetch part of master' });
  }
});

// GET part-of by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const item = await prisma.partOf.findUnique({
      where: { id },
    });
    if (!item) {
      return res.status(404).json({ error: 'Part of record not found' });
    }
    res.json(item);
  } catch (error) {
    console.error('Error fetching PartOf by ID:', error);
    res.status(500).json({ error: 'Failed to fetch part of record' });
  }
});

// POST new part-of
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, disabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const item = await prisma.partOf.create({
      data: {
        name,
        disabled: Boolean(disabled),
      },
    });
    res.status(201).json(item);
  } catch (error: any) {
    console.error('Error creating PartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to create part of record' });
  }
});

// PUT update part-of
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, disabled } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (disabled !== undefined) updateData.disabled = Boolean(disabled);

    const item = await prisma.partOf.update({
      where: { id },
      data: updateData,
    });
    res.json(item);
  } catch (error: any) {
    console.error('Error updating PartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to update part of record' });
  }
});

// DELETE part-of
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.partOf.delete({
      where: { id },
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting PartOf:', error);
    res.status(500).json({ error: 'Failed to delete part of record' });
  }
});

// POST bulk import part-of (JSON array)
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    let successCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      try {
        const name = row.name || row['Part Of Name'] || row.partOfName;
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);

        await prisma.partOf.create({
          data: {
            name: String(name).trim(),
            disabled,
          },
        });
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    res.json({ message: `Successfully imported ${successCount} records.`, count: successCount, errors });
  } catch (error: any) {
    console.error('Error bulk importing PartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import PartOf' });
  }
});

// POST bulk upload part-of (Excel/CSV)
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
        const name = row.name || row['Part Of Name'] || row.partOfName;
        if (!name) {
          errors.push(`Row ${i + 2}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);

        await prisma.partOf.create({
          data: {
            name: String(name).trim(),
            disabled,
          },
        });
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    res.json({ message: `Successfully processed ${successCount} rows.`, errors });
  } catch (error: any) {
    console.error('Error uploading PartOf file:', error);
    res.status(500).json({ error: 'Failed to process file upload' });
  }
});

export default router;
