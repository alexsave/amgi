// Example usage of the unified Korean deck processor
const { DeckProcessor, CONFIG } = require('./process-deck');
const path = require('path');

async function exampleUsage() {
    console.log('=== Korean Deck Audio Processor Example ===\n');
    
    // Example 1: Basic usage
    console.log('Example 1: Basic processing');
    console.log('node process-deck.js "Korean Vocabulary.apkg"');
    console.log('');
    
    // Example 2: With force regeneration
    console.log('Example 2: Force regenerate specific words');
    console.log('node process-deck.js "Korean Vocabulary.apkg" --force-words="대사관,학교,도서관"');
    console.log('');
    
    // Example 3: Limited processing for testing
    console.log('Example 3: Test with limited notes');
    console.log('node process-deck.js "Korean Vocabulary.apkg" --max-notes=5');
    console.log('');
    
    // Show current configuration
    console.log('Current Configuration:');
    console.log(`- Audio Directory: ${CONFIG.audioDir}`);
    console.log(`- Max Voices per Word: ${CONFIG.maxVoicesPerWord}`);
    console.log(`- Delay Between Requests: ${CONFIG.delayBetweenRequests}ms`);
    console.log(`- Force Regenerate Words: [${CONFIG.forceRegenerateWords.join(', ')}]`);
    console.log('');
    
    // Programmatic usage example
    console.log('Programmatic Usage:');
    console.log('const { DeckProcessor } = require("./process-deck");');
    console.log('const processor = new DeckProcessor("Korean Vocabulary.apkg");');
    console.log('await processor.process();');
    console.log('');
    
    console.log('Features:');
    console.log('✅ Unified processing (all 3 phases in one command)');
    console.log('✅ Progress saving and resume capability');
    console.log('✅ Smart audio regeneration criteria');
    console.log('✅ Korean phonological validation');
    console.log('✅ Multi-voice fallback system');
    console.log('✅ Conflict-free deck creation');
    console.log('✅ Review history preservation');
    console.log('✅ Automatic timestamp fixing');
    console.log('');
    
    console.log('Run with --help for full documentation');
}

if (require.main === module) {
    exampleUsage();
}