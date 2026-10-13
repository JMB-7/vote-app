import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
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
}

export class BallotOptionDto {
  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(160)
  label!: string
}

export class CreateRoundDto {
  @IsString() @Matches(/\S/) @MinLength(1) @MaxLength(200)
  title!: string

  @IsOptional() @Equals('single_choice')
  format: 'single_choice' = 'single_choice'

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => BallotOptionDto)
  options!: BallotOptionDto[]

  @IsObject()
  countingRule!: Record<string, unknown>
}

export class VoteDto {
  @IsUUID()
  optionId!: string

  @Equals(true)
  confirmation!: true
}

export class RouteIdDto {
  @IsInt() @Min(1)
  id!: number
}
