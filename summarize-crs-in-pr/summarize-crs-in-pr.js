// SPDX-FileCopyrightText: 2025 Mathieu Barbin <mathieu.barbin@gmail.com>
// SPDX-License-Identifier: MIT
// This script needs to be a  CommonJS module for use with actions/github-script.

const path = require('path');
const { execFileSync } = require('child_process');

function safePath(p) {
  // Reject absolute paths and any path containing '..' for security
  if (typeof p !== 'string' || p.includes('..') || path.isAbsolute(p)) {
    throw new Error('Unsafe crs-config path');
  }
  return p;
}

function checkCrsAvailable(core) {
  try {
    execFileSync('crs', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    core.setFailed('CRS tool not found in PATH');
    return false;
  }
}

function getCrsSummary(crsConfig, withUserMentions, reviewMode, pullRequestAuthor, core) {
  try {
    const args = [
      'tools', 'github', 'summary-comment',
      `--config=${crsConfig}`,
      `--with-user-mentions=${withUserMentions}`,
      `--review-mode=${reviewMode}`,
      `--pull-request-author=${pullRequestAuthor}`
    ];
    return execFileSync('crs', args, { encoding: 'utf8' });
  } catch (err) {
    let details = `Failed to run CRS summary-comment: ${err.message}`;
    if (typeof err.status === 'number') {
      details += `\nExit code: ${err.status}`;
    }
    if (err.stdout) {
      details += `\nStdout: ${err.stdout.toString().trim()}`;
    }
    if (err.stderr) {
      details += `\nStderr: ${err.stderr.toString().trim()}`;
    }
    core.setFailed(details);
    return null;
  }
}

async function fetchPrComments(github, context, prNumber, core) {
  try {
    const resp = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
    });
    return resp.data;
  } catch (err) {
    core.setFailed(`Failed to list PR comments: ${err.message}`);
    return null;
  }
}

async function createOrUpdateComment(github, context, prNumber, body, existing, core) {
  try {
    if (!existing) {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body,
      });
      core.info('CRS summary comment created.');
    } else if (existing.body.trim() !== body.trim()) {
      await github.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existing.id,
        body,
      });
      core.info('CRS summary comment updated.');
    } else {
      core.info('No update needed: PR comment body unchanged.');
    }
  } catch (err) {
    core.setFailed(`Failed to create/update PR comment: ${err.message}`);
  }
}

module.exports = async ({github, context, core, exec}) => {
  // Input validation
  let crsConfig;
  try {
    crsConfig = safePath(process.env.CRS_CONFIG || '.github/crs-config.json');
  } catch (err) {
    core.setFailed(`Invalid CRS config path: ${err.message}`);
    return;
  }
  const withUserMentions = (process.env.WITH_USER_MENTIONS === 'false') ? 'false' : 'true';
  const pr = context.payload.pull_request;
  const pullRequestAuthor = pr && pr.user && pr.user.login ? pr.user.login : '';
  const reviewMode = 'pull-request';

  // Check for CRS availability
  if (!checkCrsAvailable(core)) return;

  // Run the CRS summary-comment command safely
  const summary = getCrsSummary(crsConfig, withUserMentions, reviewMode, pullRequestAuthor, core);
  if (summary == null) return;

  // Build pretty summary and always append documentation header & footer
  let prettySummary = summary.trim();
  if (prettySummary === '') {
    prettySummary = [
      '### ✅ No CRs found in this pull request!'
    ].join('\n');
  } else {
    // Add a work-in-progress header for non-empty summary
    prettySummary = [
      '### 🚧 CRs assigned in this pull request',
      '',
      prettySummary
    ].join('\n');
  }
  // Always append documentation footer, separated by extra spacing and a horizontal rule
  const docFooter = [
    '',
    '',
    '-----',
    '',
    '_Generated by the **summarize-crs-in-pr** workflow - [CRs docs](https://github.com/mbarbin/crs-actions#readme)._',
    ''
  ].join('\n');
  prettySummary += docFooter;

  // Post or update PR comment with error handling
  const marker = '<!-- crs-summary-comment 877e75407e51 -->';
  const body = `${marker}\n${prettySummary}`;
  const comments = await fetchPrComments(github, context, pr.number, core);
  if (!comments) return;
  const existing = comments.find(
    c => c.user.login === 'github-actions[bot]' && c.body.includes(marker)
  );
  await createOrUpdateComment(github, context, pr.number, body, existing, core);
};
