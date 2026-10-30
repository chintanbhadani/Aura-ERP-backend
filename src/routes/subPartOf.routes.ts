import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();
const prisma = new PrismaClient();

// GET all sub-part-of items
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    const items = await prisma.subPartOf.findMany({
      where: search
        ? {
            name: {
              contains: search as string,
              mode: 'insensitive',
            },
          }
        : undefined,
      orderBy: { updatedAt: 'desc' },
    });
    res.json(items);
  } catch (error) {
    console.error('Error fetching SubPartOf:', error);
    res.status(500).json({ error: 'Failed to fetch sub-part of master' });
  }
});

// GET sub-part-of by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const item = await prisma.subPartOf.findUnique({
      where: { id },
    });
    if (!item) {
      return res.status(404).json({ error: 'Sub-part of record not found' });
    }
    res.json(item);
  } catch (error) {
    console.error('Error fetching SubPartOf by ID:', error);
    res.status(500).json({ error: 'Failed to fetch sub-part of record' });
  }
});

// POST new sub-part-of
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, disabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const item = await prisma.subPartOf.create({
      data: {
        name,
        disabled: Boolean(disabled),
      },
    });
    res.status(201).json(item);
  } catch (error: any) {
    console.error('Error creating SubPartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to create sub-part of record' });
  }
});

// PUT update sub-part-of
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, disabled } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (disabled !== undefined) updateData.disabled = Boolean(disabled);

    const item = await prisma.subPartOf.update({
      where: { id },
      data: updateData,
    });
    res.json(item);
  } catch (error: any) {
    console.error('Error updating SubPartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to update sub-part of record' });
  }
});

// DELETE sub-part-of
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.subPartOf.delete({
      where: { id },
    });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting SubPartOf:', error);
    res.status(500).json({ error: 'Failed to delete sub-part of record' });
  }
});

// POST bulk import sub-part-of (JSON array)
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
        const name = row.name || row['Sub Part Of Name'] || row.subPartOfName;
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);

        await prisma.subPartOf.create({
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
    console.error('Error bulk importing SubPartOf:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import SubPartOf' });
  }
});

// POST bulk upload sub-part-of (Excel/CSV)
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
        const name = row.name || row['Sub Part Of Name'] || row.subPartOfName;
        if (!name) {
          errors.push(`Row ${i + 2}: Missing name`);
          continue;
        }

        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);

        await prisma.subPartOf.create({
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
  } catch (error) {
    console.error('Error uploading SubPartOf file:', error);
    res.status(500).json({ error: 'Failed to process file upload' });
  }
});

export default router;
