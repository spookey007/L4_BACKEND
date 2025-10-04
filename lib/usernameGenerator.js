const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Reddit-style username generation
const ADJECTIVES = [
  'Amazing', 'Brilliant', 'Clever', 'Daring', 'Elegant', 'Fantastic', 'Glorious',
  'Happy', 'Incredible', 'Joyful', 'Kind', 'Lovely', 'Magnificent', 'Nice',
  'Outstanding', 'Perfect', 'Quick', 'Radiant', 'Smart', 'Terrific', 'Unique',
  'Vibrant', 'Wonderful', 'Excellent', 'Bright', 'Creative', 'Dynamic', 'Energetic',
  'Friendly', 'Gentle', 'Honest', 'Inspiring', 'Jovial', 'Keen', 'Lively', 'Merry',
  'Optimistic', 'Peaceful', 'Quiet', 'Reliable', 'Strong', 'Thoughtful', 'Upbeat',
  'Valuable', 'Wise', 'Youthful', 'Zealous', 'Adventurous', 'Bold', 'Confident',
  'Determined', 'Enthusiastic', 'Fearless', 'Generous', 'Hopeful', 'Independent',
  'Jubilant', 'Knowledgeable', 'Loyal', 'Motivated', 'Noble', 'Open', 'Passionate',
  'Qualified', 'Respectful', 'Successful', 'Trustworthy', 'Understanding', 'Vigorous',
  'Warm', 'Xenial', 'Yearning', 'Zestful'
];

const NOUNS = [
  'User', 'Explorer', 'Adventurer', 'Creator', 'Builder', 'Dreamer', 'Thinker',
  'Learner', 'Teacher', 'Helper', 'Friend', 'Companion', 'Guide', 'Leader',
  'Champion', 'Hero', 'Star', 'Gem', 'Pearl', 'Diamond', 'Crystal', 'Flame',
  'Spark', 'Light', 'Beam', 'Ray', 'Wave', 'Breeze', 'Wind', 'Storm', 'Thunder',
  'Lightning', 'Fire', 'Water', 'Earth', 'Air', 'Spirit', 'Soul', 'Heart',
  'Mind', 'Soul', 'Spirit', 'Angel', 'Guardian', 'Protector', 'Defender',
  'Warrior', 'Knight', 'Wizard', 'Mage', 'Sage', 'Scholar', 'Student', 'Master',
  'Expert', 'Pro', 'Ace', 'Champ', 'Winner', 'Victor', 'Conqueror', 'Explorer',
  'Pioneer', 'Trailblazer', 'Innovator', 'Inventor', 'Artist', 'Designer',
  'Architect', 'Engineer', 'Scientist', 'Researcher', 'Analyst', 'Strategist',
  'Planner', 'Organizer', 'Manager', 'Director', 'Producer', 'Creator', 'Maker',
  'Craftsman', 'Artisan', 'Technician', 'Specialist', 'Professional', 'Expert'
];

/**
 * Generate a unique Reddit-style username and display name
 * Username: Adjective + Noun + RandomNumber (e.g., "AmazingUser123")
 * Display Name: Adjective + " " + Noun (e.g., "Amazing User")
 */
async function generateUniqueUsername() {
  let attempts = 0;
  const maxAttempts = 50;
  
  while (attempts < maxAttempts) {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const randomNumber = Math.floor(Math.random() * 9999) + 1;
    
    const username = `${adjective}${noun}${randomNumber}`;
    const displayName = `${adjective} ${noun}`;
    
    // Check if username already exists (case-insensitive)
    const existingUser = await prisma.user.findUnique({
      where: { username: username.toLowerCase() }
    });
    
    if (!existingUser) {
      return { username, displayName };
    }
    
    attempts++;
  }
  
  // Fallback: use timestamp-based username if we can't find a unique one
  const timestamp = Date.now().toString().slice(-6);
  const fallbackUsername = `User${timestamp}`;
  
  // Double-check the fallback username is unique
  const existingFallback = await prisma.user.findUnique({
    where: { username: fallbackUsername.toLowerCase() }
  });
  
  if (existingFallback) {
    // If even the fallback is taken, add more randomness
    const randomSuffix = Math.floor(Math.random() * 1000);
    return { 
      username: `User${timestamp}${randomSuffix}`, 
      displayName: `User ${timestamp}` 
    };
  }
  
  return { 
    username: fallbackUsername, 
    displayName: `User ${timestamp}` 
  };
}

module.exports = {
  generateUniqueUsername
};
