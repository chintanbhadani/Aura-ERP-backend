import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET all customers
router.get('/', async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      orderBy: { name: 'asc' }
    });
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// POST new customer
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, contact, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const customer = await prisma.customer.create({
      data: { name, contact, email }
    });
    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// PUT update customer
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, contact, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const customer = await prisma.customer.update({
      where: { id },
      data: { name, contact, email }
    });
    res.json(customer);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE customer
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.customer.delete({
      where: { id }
    });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

export default router;
