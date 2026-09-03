const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const category = await prisma.category.upsert({
    where: { id: 'default-cat-1' },
    update: {},
    create: {
      id: 'default-cat-1',
      name: 'Raw Materials',
    },
  });

  const supplier = await prisma.supplier.upsert({
    where: { id: 'default-sup-1' },
    update: {},
    create: {
      id: 'default-sup-1',
      name: 'Alpha Chemicals Inc.',
      contact: 'John Smith',
      email: 'sales@alphachem.com',
    },
  });

  const user = await prisma.user.upsert({
    where: { username: 'admin@aura.com' },
    update: {},
    create: {
      username: 'admin@aura.com',
      password: 'password123',
      role: 'PLANT_ADMIN',
    },
  });

}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
