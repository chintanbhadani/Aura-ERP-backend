"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const auth_1 = require("../middleware/auth");
const barcodeEngine_1 = require("../services/barcodeEngine");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// Only Admins and Supervisors can create jobs
router.post('/', (0, auth_1.authorizeRole)('PLANT_ADMIN', 'SHIFT_SUPERVISOR'), async (req, res) => {
    try {
        const { machine, shift, targetDimensions, priority } = req.body;
        const job = await prisma.productionJob.create({
            data: {
                machine,
                shift,
                targetDimensions,
                priority,
                // Assuming req.user is set by auth middleware
                supervisorId: req.user?.id
            }
        });
        res.status(201).json(job);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create job' });
    }
});
router.get('/', (0, auth_1.authorizeRole)('PLANT_ADMIN', 'SHIFT_SUPERVISOR', 'QC_INSPECTOR', 'SALES_REP'), async (req, res) => {
    try {
        const jobs = await prisma.productionJob.findMany();
        res.json(jobs);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});
// Endpoint to manually add a roll (though it might usually be done via scale listener)
router.post('/:id/rolls', (0, auth_1.authorizeRole)('PLANT_ADMIN', 'SHIFT_SUPERVISOR'), async (req, res) => {
    try {
        const { id } = req.params;
        const { grossWeight, coreTareWeight = 1.0, netWeight } = req.body;
        const job = await prisma.productionJob.findUnique({ where: { id } });
        if (!job)
            return res.status(404).json({ error: 'Job not found' });
        const barcode = barcodeEngine_1.BarcodeEngine.generateRollSticker(job.shift, job.machine);
        const roll = await prisma.rollEntry.create({
            data: {
                barcode,
                grossWeight,
                coreTareWeight,
                netWeight,
                jobId: job.id
            }
        });
        res.status(201).json(roll);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create roll' });
    }
});
exports.default = router;
