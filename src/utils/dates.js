/**
 * Date utilities for consistent timezone handling
 */

/**
 * Get today's date in YYYY-MM-DD format in the user's local timezone.
 * This handles timezone conversion properly by:
 * 1. Creating a date in the user's local timezone
 * 2. Getting the year, month, and day in their timezone
 * 3. Formatting it consistently as YYYY-MM-DD
 */
export const getLocalDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Get a timestamp for the end of the current day (23:59:59.999) in ISO format.
 * This is specifically for database filtering when we need to include all timestamps 
 * that occur on or before the current day.
 */
export const getEndOfDayTimestamp = (date = new Date()) => {
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const isoString = endOfDay.toISOString();
  
  return isoString;
};

/**
 * Parse a YYYY-MM-DD string into a Date object in the user's local timezone.
 * The time will be set to midnight (00:00:00) in the user's timezone.
 */
export const parseLocalDate = (dateStr) => {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
};

/**
 * Add days to a date, preserving the local timezone
 */
export const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

/**
 * Compare two YYYY-MM-DD date strings
 * Returns negative if a < b, 0 if equal, positive if a > b
 */
export const compareDates = (a, b) => {
  return parseLocalDate(a) - parseLocalDate(b);
}; 