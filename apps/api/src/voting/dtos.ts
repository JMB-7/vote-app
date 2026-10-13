import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayMinSize,
  IsBoolean,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'

export class CreateAssemblyDto {
  @IsString() @Matches(/\S/) @MinLength(2) @MaxLength(160)
  name!: string
}

export class JoinAssemblyDto {
  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(80)
  firstName!: string

  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(100)
  lastName!: string
}

export class LobbyPatchDto {
  @IsIn(['lobby_open', 'lobby_closed'])
  status!: 'lobby_open' | 'lobby_closed'
}

export class CompleteAssemblyDto {
  @Equals(true)
  confirmation!: true
}

export class ParticipantPatchDto {
  @IsOptional() @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(80)
  firstName?: string

  @IsOptional() @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(100)
  lastName?: string

  @IsOptional() @Equals('removed')
  status?: 'removed'

  @IsOptional() @IsIn(['president', 'vice_president', 'secretary', 'treasurer', 'delegate'])
  assemblyRole?: 'president' | 'vice_president' | 'secretary' | 'treasurer' | 'delegate' | null

  @IsOptional() @IsBoolean()
  committeeEligible?: boolean
}

export class BallotOptionDto {
  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(160)
  label!: string

  @IsOptional() @IsUUID()
  candidateParticipantId?: string
}

export class CommitteeConfigurationDto {
  @IsOptional() @IsBoolean()
  institutionallyValidated?: boolean

  @IsOptional() @IsString() @MaxLength(200)
  validationReference?: string

  @IsOptional() @IsString() @MaxLength(1000)
  eligibilityRule?: string

  @IsOptional() @IsString() @MaxLength(1000)
  votingMethod?: string

  @IsOptional() @IsString() @MaxLength(1000)
  @IsIn(['eligible_delegate_only'])
  proposalRule?: 'eligible_delegate_only'

  @IsOptional() @IsIn(['one_per_eligible_delegate'])
  supportRule?: 'one_per_eligible_delegate'

  @IsOptional() @IsInt() @Min(1)
  supportMinimum?: number

  @IsOptional() @IsIn(['eligible_delegates', 'valid_votes'])
  approvalDenominator?: 'eligible_delegates' | 'valid_votes'
}

export class CreateRoundDto {
  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(200)
  title!: string

  @IsOptional() @IsIn(['single_choice', 'multiple_choice'])
  format: 'single_choice' | 'multiple_choice' = 'single_choice'

  @IsOptional() @IsIn(['office', 'committee'])
  category?: 'office' | 'committee'

  @IsOptional() @IsIn(['nomination', 'finance', 'statutes', 'plans', 'other'])
  committeeType?: 'nomination' | 'finance' | 'statutes' | 'plans' | 'other'

  @IsOptional() @IsInt() @Min(1)
  memberCount?: number

  @IsOptional() @IsString() @MaxLength(1000)
  decisionNote?: string

  @IsOptional() @ValidateNested() @Type(() => CommitteeConfigurationDto)
  committeeConfiguration?: CommitteeConfigurationDto

  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => BallotOptionDto)
  options?: BallotOptionDto[]

  @IsObject()
  countingRule!: Record<string, unknown>
}

export class VoteDto {
  @IsOptional() @IsUUID()
  optionId?: string

  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(40) @IsUUID('all', { each: true })
  optionIds?: string[]

  @Equals(true)
  confirmation!: true
}

export class CommitteeProposalDto {
  @IsUUID()
  candidateParticipantId!: string
}

export class CommitteeApprovalDto {
  @IsInt() @Min(0)
  yesVotes!: number

  @IsInt() @Min(0)
  noVotes!: number
}

export class CommitteeStageDto {
  @IsIn(['support', 'approval', 'election'])
  stage!: 'support' | 'approval' | 'election'
}

export class CommitteeConfigurationUpdateDto {
  @IsOptional() @IsInt() @Min(1)
  memberCount?: number

  @IsOptional() @IsString() @MaxLength(1000)
  decisionNote?: string

  @IsOptional() @ValidateNested() @Type(() => CommitteeConfigurationDto)
  committeeConfiguration?: CommitteeConfigurationDto
}

export class OfficialResultDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @IsUUID('all', { each: true })
  optionIds!: string[]

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string
}

export class RouteIdDto {
  @IsInt() @Min(1)
  id!: number
}
