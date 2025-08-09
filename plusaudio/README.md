# Korean Deck Audio Processor

A unified tool that enhances Korean Anki decks with high-quality AI-generated audio using GPT-4o.

## Features

- **Smart Audio Generation**: Uses GPT-4o-audio-preview with Korean phonological validation
- **Multi-voice Fallback**: Tries up to 5 different voices if validation fails
- **Progress Saving**: Automatically saves progress and can resume from interruptions
- **Unified Processing**: Combines audio generation, deck creation, and timestamp fixing in one command
- **Conflict-Free Import**: Creates new deck with unique IDs to avoid collection conflicts
- **Review History Preservation**: Maintains all your existing review statistics

## Quick Start

```bash
# Process a Korean deck with enhanced audio
node process-deck.js "Korean Vocabulary by Evita (with Audio).apkg"
```

## Usage

```bash
node process-deck.js <path-to-apkg-file> [options]

Options:
  --help, -h                    Show help message
  --force-words="word1,word2"   Force regenerate specific Korean words
  --max-notes=N                 Limit processing to N notes (for testing)

Examples:
  node process-deck.js "Korean Vocabulary.apkg"
  node process-deck.js "Korean Vocabulary.apkg" --force-words="대사관,학교"
  node process-deck.js "Korean Vocabulary.apkg" --max-notes=10
```

## Processing Phases

### Phase 1: Audio Generation 🎵
- Analyzes your deck structure and detects Korean vocabulary
- Generates high-quality audio using GPT-4o-audio-preview
- Validates audio through blind transcription and Korean phonological analysis
- Saves audio files to `audio/` directory with progress tracking

### Phase 2: Deck Creation 📦
- Creates a new .apkg deck with embedded audio files
- Updates note references to include audio in the appropriate fields
- Generates new unique IDs to avoid conflicts with existing collection
- Preserves all review history and card relationships

### Phase 3: Timestamp Fixing ⏰
- Adjusts review timestamps to be in the recent past
- Ensures proper display in Anki's statistics and calendar views
- Maintains the original review timeline span

## Interruption Handling

The script automatically saves progress and can be resumed:

1. **During Audio Generation**: Progress saved every 10 notes
2. **If Interrupted**: Run the same command again to resume
3. **Phase Completion**: Each phase completion is saved, completed phases are skipped on resume

## Output

- **Enhanced Deck**: `[Original Name] (with Audio Enhanced).apkg`
- **Audio Files**: Saved in `audio/` directory as `{korean_text}_gpt4o.mp3`
- **Progress File**: `[Original Name]_progress.json` for resumption

## Requirements

- Node.js with required packages (yauzl, yazl, better-sqlite3, openai)
- OpenAI API key in `.env` file
- ffmpeg (optional, for audio analysis)

## Error Handling

- **Rate Limits**: Automatically detected, script stops gracefully
- **Audio Validation**: Multiple voices tried if transcription fails
- **Critical Errors**: Progress saved before exit, resume from last checkpoint

## Configuration

Edit the `CONFIG` object in `process-deck.js` to customize:
- Audio directory location
- Generation parameters (voices, attempts, delays)
- Force regenerate word list

## Workflow Comparison

### Before (3 separate scripts):
1. `node index.js` - Generate audio
2. `node update-augmented-deck.js` - Create deck
3. `node fix-review-timestamps.js` - Fix timestamps

### After (1 unified script):
```bash
node process-deck.js "Korean Vocabulary.apkg"
```

## Safety

- Original deck is never modified
- All generated content uses unique IDs
- Review history and statistics fully preserved
- Can be safely imported alongside original deck