"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all customers
router.get('/', async (req, res) => {
    try {
        const customers = await prisma.customer.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(customers);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});
// POST new customer
router.post('/', async (req, res) => {
    try {
        const { name, contact, email } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const customer = await prisma.customer.create({
            data: { name, contact, email }
        });
        res.status(201).json(customer);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create customer' });
    }
});
// PUT update customer
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, contact, email } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const customer = await prisma.customer.update({
            where: { id },
            data: { name, contact, email }
        });
        res.json(customer);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update customer' });
    }
});
// DELETE customer
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.customer.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete customer' });
    }
});
exports.default = router;
