import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// GET all suppliers
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const suppliers = await prisma.supplier.findMany({
      where: {
        AND: [
          search ? { name: { contains: search as string, mode: 'insensitive' } } : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: { name: 'asc' }
    });
    res.json(suppliers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// GET supplier by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        products: true,
        invoices: true,
        payments: true,
        _count: {
          select: {
            products: true,
            invoices: true,
            payments: true,
          }
        }
      }
    });

    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    res.json(supplier);
  } catch (error: any) {
    console.error('Error fetching supplier by id:', error);
    res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

// POST new supplier
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, contact, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const supplier = await prisma.supplier.create({
      data: { name, contact, email }
    });
    res.status(201).json(supplier);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// PUT update supplier
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, contact, email, status } = req.body;
    if (!name && !status) return res.status(400).json({ error: 'Data is required to update' });

    const updateData: any = {};
    if (name) updateData.name = name;
    if (contact !== undefined) updateData.contact = contact;
    if (email !== undefined) updateData.email = email;
    if (status) updateData.status = status;

    const supplier = await prisma.supplier.update({
      where: { id },
      data: updateData
    });
    res.json(supplier);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// DELETE supplier
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.supplier.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

// POST bulk upload suppliers
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

        await prisma.supplier.create({
          data: { 
            name: row.name,
            contact: row.contact ? String(row.contact) : null,
            email: row.email ? String(row.email) : null
          }
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

// POST bulk import suppliers (JSON array)
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
        const name = (row.name || row.supplierName || row['Supplier Name'] || '').toString().trim();
        if (!name) {
          errors.push(`Row ${i + 1}: Missing name`);
          continue;
        }

        const contact = (row.contact || row.phone || row['Phone / Contact'] || '').toString().trim() || null;
        const email = (row.email || row['Email'] || '').toString().trim() || null;
        const disabledVal = row.disabled ?? row['Disabled'] ?? row.isDisabled;
        const disabled = typeof disabledVal === 'string'
          ? ['yes', 'true', '1'].includes(disabledVal.trim().toLowerCase())
          : Boolean(disabledVal);
        const status = disabled ? 'Inactive' : 'Active';

        const existing = await prisma.supplier.findFirst({
          where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existing) {
          await prisma.supplier.update({
            where: { id: existing.id },
            data: {
              contact: contact || existing.contact,
              email: email || existing.email,
              status
            }
          });
          updatedCount++;
        } else {
          await prisma.supplier.create({
            data: {
              name,
              contact,
              email,
              status
            }
          });
          createdCount++;
        }
        successCount++;
      } catch (err: any) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }

    res.json({
      message: `Successfully processed ${successCount} suppliers (${createdCount} created, ${updatedCount} updated).`,
      count: successCount,
      successCount,
      createdCount,
      updatedCount,
      errors
    });
  } catch (error: any) {
    console.error('Failed to bulk import suppliers:', error);
    res.status(500).json({ error: error.message || 'Failed to bulk import suppliers' });
  }
});

export default router;
