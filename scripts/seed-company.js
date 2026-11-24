const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedCompany() {
  console.log('🌱 Seeding Company Master...');
  try {
    const existing = await prisma.company.findFirst({
      where: {
        OR: [
          { name: { equals: 'Shashtri Hardware', mode: 'insensitive' } },
          { name: { equals: 'Shastri Hardware', mode: 'insensitive' } }
        ]
      }
    });

    if (existing) {
      console.log(`ℹ️ Company "${existing.name}" already exists (ID: ${existing.id}).`);
      return existing;
    }

    const company = await prisma.company.create({
      data: {
        name: 'Shashtri Hardware',
        code: 'SH',
        taxId: 'TIN-1002348921',
        email: 'sales@shashtrihardware.com',
        phone: '+256 700 123456',
        address: 'Plot 42, Jinja Road, Industrial Area',
        city: 'Kampala',
        country: 'Uganda',
        currency: 'USh',
        isDefault: true,
        status: 'Active'
      }
    });

    console.log(`✅ Company "${company.name}" created successfully as Default Company!`);
    console.log(`   ID: ${company.id}`);
    console.log(`   Code: ${company.code}`);
    console.log(`   TIN: ${company.taxId}`);
    return company;
  } catch (error) {
    console.error('❌ Failed to seed company:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedCompany()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { seedCompany };
