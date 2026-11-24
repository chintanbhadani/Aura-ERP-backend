import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all companies
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, status } = req.query;
    const companies = await prisma.company.findMany({
      where: {
        AND: [
          search
            ? {
                OR: [
                  { name: { contains: search as string, mode: 'insensitive' } },
                  { code: { contains: search as string, mode: 'insensitive' } },
                  { email: { contains: search as string, mode: 'insensitive' } },
                  { phone: { contains: search as string, mode: 'insensitive' } },
                ]
              }
            : {},
          status && status !== 'ALL' ? { status: status as any } : {}
        ]
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { invoices: true }
        }
      }
    });

    res.json(companies.map((c) => ({
      ...c,
      disabled: c.status === 'Inactive'
    })));
  } catch (error: any) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET company by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: { invoices: true }
        }
      }
    });

    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({
      ...company,
      disabled: company.status === 'Inactive'
    });
  } catch (error: any) {
    console.error('Error fetching company by id:', error);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// POST create company
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, code, taxId, email, phone, address, city, country, currency, isDefault, status } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const trimmedName = String(name).trim();

    // Check duplicate
    const existing = await prisma.company.findUnique({
      where: { name: trimmedName }
    });
    if (existing) {
      return res.status(400).json({ error: 'Company with this name already exists' });
    }

    // If marked as default, unset existing defaults
    if (isDefault) {
      await prisma.company.updateMany({
        where: { isDefault: true },
        data: { isDefault: false }
      });
    }

    const company = await prisma.company.create({
      data: {
        name: trimmedName,
        code: code ? String(code).trim().toUpperCase() : null,
        taxId: taxId ? String(taxId).trim() : null,
        email: email ? String(email).trim() : null,
        phone: phone ? String(phone).trim() : null,
        address: address ? String(address).trim() : null,
        city: city ? String(city).trim() : null,
        country: country ? String(country).trim() : 'Uganda',
        currency: currency ? String(currency).trim() : 'USh',
        isDefault: Boolean(isDefault),
        status: status === 'Inactive' ? 'Inactive' : 'Active'
      }
    });

    res.status(201).json(company);
  } catch (error: any) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: error.message || 'Failed to create company' });
  }
});

// PUT update company
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, code, taxId, email, phone, address, city, country, currency, isDefault, status, disabled } = req.body;

    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (name && String(name).trim() !== existing.name) {
      const duplicate = await prisma.company.findUnique({
        where: { name: String(name).trim() }
      });
      if (duplicate && duplicate.id !== id) {
        return res.status(400).json({ error: 'Company with this name already exists' });
      }
    }

    if (isDefault) {
      await prisma.company.updateMany({
        where: { id: { not: id }, isDefault: true },
        data: { isDefault: false }
      });
    }

    let finalStatus = status;
    if (disabled !== undefined) {
      finalStatus = disabled ? 'Inactive' : 'Active';
    }

    const updated = await prisma.company.update({
      where: { id },
      data: {
        name: name !== undefined ? String(name).trim() : undefined,
        code: code !== undefined ? (code ? String(code).trim().toUpperCase() : null) : undefined,
        taxId: taxId !== undefined ? (taxId ? String(taxId).trim() : null) : undefined,
        email: email !== undefined ? (email ? String(email).trim() : null) : undefined,
        phone: phone !== undefined ? (phone ? String(phone).trim() : null) : undefined,
        address: address !== undefined ? (address ? String(address).trim() : null) : undefined,
        city: city !== undefined ? (city ? String(city).trim() : null) : undefined,
        country: country !== undefined ? (country ? String(country).trim() : 'Uganda') : undefined,
        currency: currency !== undefined ? (currency ? String(currency).trim() : 'USh') : undefined,
        isDefault: isDefault !== undefined ? Boolean(isDefault) : undefined,
        status: finalStatus ? (finalStatus === 'Inactive' ? 'Inactive' : 'Active') : undefined
      }
    });

    res.json(updated);
  } catch (error: any) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: error.message || 'Failed to update company' });
  }
});

// DELETE company
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if invoices are linked
    const invoiceCount = await prisma.invoice.count({
      where: { companyId: id }
    });

    if (invoiceCount > 0) {
      return res.status(400).json({
        error: `Cannot delete company: ${invoiceCount} invoice(s) are linked to it. Please deactivate the company instead.`
      });
    }

    await prisma.company.delete({ where: { id } });
    res.json({ message: 'Company deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: error.message || 'Failed to delete company' });
  }
});

export default router;
