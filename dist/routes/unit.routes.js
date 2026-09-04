"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all units
router.get('/', async (req, res) => {
    try {
        const units = await prisma.unit.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(units);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch units' });
    }
});
// POST new unit
router.post('/', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const unit = await prisma.unit.create({
            data: { name }
        });
        res.status(201).json(unit);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create unit' });
    }
});
// PUT update unit
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const unit = await prisma.unit.update({
            where: { id },
            data: { name }
        });
        res.json(unit);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update unit' });
    }
});
// DELETE unit
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.unit.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete unit' });
    }
});
exports.default = router;
