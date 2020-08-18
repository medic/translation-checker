const {TranslationException} = require('./errors');
const {parseProperties} = require('./fs');
const {fileLanguage, isLanguageCodeValid, translationFileNames} = require('./parse-name');
const _ = require('lodash');
const path = require('path');
const MessageFormat = require('messageformat');

const MUSTACHE_MATCHER = /{{[\s\w.#^/'|]+}}/g;
const MUSTACHE_REPLACER_MATCHER = /[{}\s#^/']*/g;

const EN_FILE = 'messages-en.properties';
const EX_FILE = 'messages-ex.properties';


/**
 * Check all the languages translations, optionally using `baseTranslations`
 * as template translations when placeholders are used.
 *
 * @param {string} dir - directory where the translation files with name messages-XX.properties are stored
 * @param {Object} options - optional arguments to perform the translations check
 * @param {string[]} options.languages - the lowercase ISO 639-1 code languages to be checked. Do not
 *        set to check all the languages found at `dir`
 * @param {boolean} [options.checkPlaceholders=true] - whether to check missed placeholders or not
 * @param {boolean} [options.checkMessageformat=true] - whether to check wrong Messageformat or not
 * @param {boolean} [options.checkEmpties=true] - whether to check empty messages or not
 *
 * @returns {Promise<string[]>} resolved promise with the list of translation files processed if there
 *        are no errors, or a rejected one with a `TranslationException` error.
 *
 *        The exception has an attribute "errors" that is an array with the validations failed, and
 *        the following fields:
 *
 *            {
 *              message: "Error trying to compile translations",
 *              fileNames: [
 *                "messages-en.properties",
 *                "messages-es.properties",
 *                "messages-hi.properties",
 *                "messages-it.properties"
 *              ],
 *              errors: [
 *                {error: "missed-placeholder",  lang: "es", key: "n.month", message: "key not found in base translations"},
 *                {error: "wrong-placeholder",   lang: "hi", key: "user.greeting", message: "placeholders not found in base translations"},
 *                {error: "wrong-messageformat", lang: "hi", key: "records.count", message: "Expected \",\" but \"o\" found", cause: Error(...)},
 *                ...
 *              ]
 *            }
 */
async function checkTranslations(
  dir,
  { checkPlaceholders=true,  checkMessageformat=true, checkEmpties=true }={}
) {
  const errors = [];
  const fileNames = await translationFileNames(dir, options.languages);
  let enTranslations = {};
  let exTranslations = {};
  let templatePlaceholders = null;
  if (options.checkPlaceholders) {
    if (fileNames.indexOf(EN_FILE) >= 0) {
      enTranslations = await parseProperties(path.join(dir, EN_FILE));
    }
    if (fileNames.indexOf(EX_FILE) >= 0) {
      exTranslations = await parseProperties(path.join(dir, EX_FILE));
    }
    templatePlaceholders = extractPlaceholdersFromTranslations(enTranslations, exTranslations);
  }
  for (const fileName of fileNames) {
    let translations;
    if (options.checkPlaceholders && fileName === EN_FILE) {         // Do not process again 'en'
      translations = enTranslations;
    } else if (options.checkPlaceholders && fileName === EX_FILE) {  // Do not process again 'ex'
      translations = exTranslations;
    } else {
      translations = await parseProperties(path.join(dir, fileName));
    }
    if (fileName !== EX_FILE) {
      errors.push(
        ...checkFileTranslations(
          translations, fileName, templatePlaceholders,
          options.checkMessageformat, options.checkEmpties
        )
      );
    }
  }
  if (errors.length) {
    throw new TranslationException(
      'Error trying to compile translations', errors, fileNames);
  }
  return fileNames;
}

function checkFileTranslations(
  translations,
  fileName,
  templatePlaceholders,
  checkMessageformat,
  checkEmpties
) {
  const errors = [];
  const lang = fileLanguage(fileName);
  let mf = null;
  if (checkMessageformat) {
    try {
      mf = new MessageFormat(lang);
    } catch (e) {
      // unknown language, won't check messageformat
    }
  }
  const placeholders = extractPlaceholdersFromTranslations(translations);
  for (const [msgKey, msgSrc] of Object.entries(translations)) {
    if (!msgSrc) {
      if (checkEmpties) {
        errors.push({
          lang: lang,
          error: 'empty-message',
          key: msgKey,
          message: `Empty message found for key '${msgKey}' in '${lang}' translation`
        });
      }
    } else if (typeof msgSrc === 'string') {
      if (msgSrc.match(MUSTACHE_MATCHER) !== null) {
        if (templatePlaceholders) {
          const msgPlaceholders = placeholders[msgKey];
          if (msgPlaceholders) {
            const templatePlaceholder = templatePlaceholders[msgKey];
            if (!templatePlaceholder) {
              errors.push({
                lang: lang,
                error: 'missed-placeholder',
                key: msgKey,
                message: `Cannot compile '${lang}' translation with key '${msgKey}' has placeholders, `
                  + 'but base translations does not have placeholders'
              });
            } else {
              const foundAllPlaceholders = msgPlaceholders.every(el => templatePlaceholder.includes(el));
              if (!foundAllPlaceholders) {
                errors.push({
                  lang: lang,
                  error: 'wrong-placeholder',
                  key: msgKey,
                  message: `Cannot compile '${lang}' translation with key '${msgKey}' has placeholders `
                    + 'that do not match any in the base translation provided'
                });
              }
            }
          }
        }
      } else if (mf) {
        try {
          mf.compile(msgSrc);
        } catch (e) {
          errors.push({
            lang: lang,
            error: 'wrong-messageformat',
            key: msgKey,
            message: `Cannot compile '${lang}' translation ${msgKey} = '${msgSrc}' : ${e.message}`
          });
        }
      }
    }
  }
  return errors;
}

function extractPlaceholdersFromTranslations(translations, extraPlaceholders = {}) {
  // Extract from github.com/medic/cht-core/blob/master/scripts/poe/lib/utils.js
  const result = {};
  for (const [msgKey, msgSrc] of Object.entries(translations)) {
    let msgPlaceholders = [];
    if (typeof msgSrc === 'string') {
      msgPlaceholders = extractPlaceholdersKeysFromMsg(msgSrc);
    }
    if (typeof extraPlaceholders[msgKey] === 'string') {
      msgPlaceholders =
        msgPlaceholders.concat(extractPlaceholdersKeysFromMsg(extraPlaceholders[msgKey]));
    }
    if (msgPlaceholders.length) {
      result[msgKey] = _.uniq(msgPlaceholders);
    } else if (extraPlaceholders[msgKey]) {
      result[msgKey] = extraPlaceholders[msgKey];
    }
  }
  return result;
}

function extractPlaceholdersKeysFromMsg(message) {
  // 'This is {{var1}} and this is {{ ^var2 }}' => [ '{{var1}}', '{{ ^var2 }}' ]
  const placeholders = message.match(MUSTACHE_MATCHER) || [];
  // ... => [ 'var1', 'var2' ]
  return placeholders.map(s=>s.replace(MUSTACHE_REPLACER_MATCHER, ''));
}

module.exports = {
  checkTranslations,
  fileLanguage,
  isLanguageCodeValid,
  TranslationException
};
