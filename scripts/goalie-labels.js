/*
 * Copyright 2022 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Codeowners = require('codeowners');

module.exports = async ({ github, context, core }) => {
  // first get all open pull requests
  const allPullRequests = await github.paginate(github.rest.pulls.list, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'open',
  });

  const { data: teams } = await github.request('GET /orgs/{org}/teams', {
    org: context.repo.owner,
  });

  const groupMembers = await Promise.all(
    teams.map(async team => {
      const { data } = await github.rest.teams.listMembersInOrg({
        org: context.repo.owner,
        team_slug: team.slug,
      });

      return { team: `@backstage/${team.slug}`, data };
    }),
  );

  const codeowners = new Codeowners();

  for (const pullRequest of allPullRequests) {
    // Go through each file changed and get the codeowners for that file.
    // Find the group in the group list that matches the codeowner.
    // If it does match push the owner to a list of reviewers
    // check to see the reviews and if there is at least one matching reviewer from those group

    const changedFiles = await github.paginate(github.rest.pulls.listFiles, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullRequest.number,
    });

    const allReviews = await github.paginate(github.rest.pulls.listReviews, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pullRequest.number,
    });

    const expectedReviewers = new Set();

    for (const file of changedFiles) {
      expectedReviewers.add(...codeowners.getOwner(file.filename));
    }

    const hasReviewed = new Set();

    // For each reviewer in the group, check to see if they have a review set
    for (const reviewer of expectedReviewers) {
      const members = groupMembers.find(member => member.team === reviewer);
      if (members) {
        // then we are dealing with a group
        const hasMemberReview = allReviews.some(review =>
          members.data.some(member => member.login === review.user.login),
        );
        if (hasMemberReview) {
          hasReviewed.add(reviewer);
        }
      } else {
        // reviewer is a person
        const hasReview = allReviews.some(
          review => reviewer === `@${review.user.login}`,
        );
        if (hasReview) {
          hasReviewed.add(reviewer);
        }
      }
    }

    // if all required reviewers have reviewed
    if (hasReviewed.size === expectedReviewers.size) {
      const recentEventsForPR = await github.paginate(
        github.rest.issues.listEvents,
        {
          issue_number: pullRequest.number,
          owner: context.repo.owner,
          repo: context.repo.repo,
        },
      );

      // if the last event for the issue is not by the author, remove the label
      if (
        recentEventsForPR[recentEventsForPR.length - 1].actor.login !==
        pullRequest.user.login
      ) {
        await github.rest.issues
          .removeLabel({
            issue_number: pullRequest.number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            name: 'awaiting-review',
          })
          .catch(e => {
            console.error(e);
          });
      }
      // add the awaiting-review label to tell us that the PR is waiting on reviews
    } else {
      await github.rest.issues
        .addLabels({
          issue_number: pullRequest.number,
          owner: context.repo.owner,
          repo: context.repo.repo,
          labels: ['awaiting-review'],
        })
        .catch(e => {
          console.error(e);
        });
    }
  }
};
