Feature: AI-DLC is imported from its source

  Background:
    Given the AI-DLC source at the pinned version

  Scenario: The import brings over everything
    When I import AI-DLC
    Then the aidlc pack covers all 33 stages as 30 steps plus run setup
    And it has 14 roles, 11 profiles and 6 verifiers
    And 13 steps have a review step
    And "foundry validate" passes on the aidlc pack

  Scenario: No AI-DLC engine calls survive the import
    When I import AI-DLC
    Then no step instruction calls AI-DLC's own engine
    And every rewrite applied is listed in the import report

  Scenario: An unknown engine call fails the import
    Given a stage text with an engine call missing from the rewrite table
    When I import AI-DLC
    Then the import fails and names the stage and the call

  Scenario: Importing twice gives the same pack
    When I import AI-DLC twice
    Then both packs are identical

  Scenario Outline: Profiles compile to the right steps
    Given the aidlc pack is imported
    When I dry-run the "<profile>" profile
    Then the plan has <steps> stage steps after run setup

    Examples:
      | profile | steps |
      | bugfix  | 6     |
      | feature | 30    |

  Scenario: Skipped conditional stages leave their outputs absent by design
    Given the aidlc pack is imported
    And a "feature" run where "infrastructure-design" is skipped
    Then the steps that read its outputs start without them
    And no step reports a missing required input

  Scenario: Runs default to AI-DLC's simplest settings
    Given the aidlc pack is imported
    When I dry-run the "feature" profile
    Then every step runs with its lead role only
    And reviews are advisory
    And code plans wait at an approval gate
